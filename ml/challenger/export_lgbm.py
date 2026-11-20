"""Рабочая модель: LightGBM с монотонными ограничениями → формат сервиса.

Запуск (из корня проекта, после `npm run export-bench`):
    .venv/Scripts/python ml/challenger/export_lgbm.py
    npm run train -- --import ml/challenger/lgbm-monotone.json

Почему так. Сравнение претендентов (ml/challenger/benchmark.py) показало: LightGBM и InterpretML
находят больше дропперов, чем наш прежний бустинг, но без ограничений обе модели решают, что «очень
много незнакомых отправителей» — признак честного продавца. На синтетике это верно, а в жизни так
выглядит счёт-сборщик, на который несут деньги десятки жертв. Поэтому риск обязан не падать, когда
счёт моложе, незнакомых отправителей больше, вывод быстрее и общих устройств больше. LightGBM
выдерживает это ограничение почти без потерь, наш бустинг и InterpretML — с потерей 4–10 п.п.

Что делает скрипт:
1. Подбирает настройки Optuna на validation (test не трогает).
2. Обучает модель на train с ограничениями монотонности (метод advanced).
3. Сохраняет деревья в компактном виде для service/src/trees.ts и контрольные счета: оценку и
   вклад каждого признака (SHAP) по самому LightGBM. ml/train.ts при импорте пересчитывает их своим
   кодом и останавливается, если хоть одно число разошлось.

Шкала риска. Модель учится с умеренным весом дропперов (его подбирает Optuna). Чтобы риск остался в
прежней шкале — как при равном весе классов, — к оценке прибавляется постоянный сдвиг. Порядок
счетов, пороги по доле ложных срабатываний и все метрики от этого не меняются, вклады признаков тоже.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import lightgbm as lgb
import numpy as np
import optuna
import pandas as pd

ROOT = Path(__file__).resolve().parent
FEATURES = ["account_age_days", "unrelated_senders_7d", "fast_outflow_share_7d", "shared_device_accounts"]
MONOTONE = [-1, 1, 1, 1]
SEED = 20261112
TARGET_FPR = {"warn": 0.02, "hold": 0.003}
TRIALS = 80
CHECK_ROWS = 500

optuna.logging.set_verbosity(optuna.logging.WARNING)


def recall_at(scores: np.ndarray, y: np.ndarray, fpr: float) -> float:
    honest = np.sort(scores[y == 0])[::-1]
    return float((scores[y == 1] >= honest[int(len(honest) * fpr)]).mean())


def fit(params: dict, x: pd.DataFrame, y: np.ndarray) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        objective="binary",
        subsample_freq=1,
        monotone_constraints=MONOTONE,
        monotone_constraints_method="advanced",
        random_state=SEED,
        verbose=-1,
        n_jobs=-1,
        **params,
    ).fit(x, y)


def compact(node: dict, tree: dict) -> int:
    """Дерево из dump_model в плоские списки: номер узла → признак, порог, дети, значение, покрытие."""
    index = len(tree["feature"])
    for key in tree:
        tree[key].append(None)
    if "leaf_index" in node:
        tree["feature"][index] = -1
        tree["value"][index] = node["leaf_value"]
        tree["cover"][index] = node["leaf_count"]
        tree["threshold"][index] = tree["left"][index] = tree["right"][index] = 0
        return index
    assert node["decision_type"] == "<=", node["decision_type"]
    tree["feature"][index] = node["split_feature"]
    tree["threshold"][index] = node["threshold"]
    tree["value"][index] = node["internal_value"]
    tree["cover"][index] = node["internal_count"]
    tree["left"][index] = compact(node["left_child"], tree)
    tree["right"][index] = compact(node["right_child"], tree)
    return index


def main() -> None:
    df = pd.read_csv(ROOT / "data" / "bench.csv")
    train, validation, test = (df[df.split == s].reset_index(drop=True) for s in ("train", "validation", "test"))
    x_train, y_train = train[FEATURES], train["is_dropper"].to_numpy()
    yv = validation["is_dropper"].to_numpy()

    def objective(trial: optuna.Trial) -> float:
        params = {
            "n_estimators": trial.suggest_int("n_estimators", 100, 900, step=50),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.2, log=True),
            "num_leaves": trial.suggest_int("num_leaves", 7, 127, log=True),
            "min_child_samples": trial.suggest_int("min_child_samples", 10, 400, log=True),
            "reg_lambda": trial.suggest_float("reg_lambda", 1e-3, 30, log=True),
            "subsample": trial.suggest_float("subsample", 0.5, 1.0),
            "scale_pos_weight": trial.suggest_float("scale_pos_weight", 1, 60, log=True),
        }
        sv = fit(params, x_train, y_train).predict(validation[FEATURES], raw_score=True)
        # больше всего ценим строгий порог «придержать»: там ошибка дороже
        return 0.6 * recall_at(sv, yv, TARGET_FPR["hold"]) + 0.4 * recall_at(sv, yv, TARGET_FPR["warn"])

    study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=SEED))
    study.optimize(objective, n_trials=TRIALS)
    params = study.best_params
    print(f"Optuna, {TRIALS} попыток, лучшая цель на validation {study.best_value:.4f}: {params}")

    model = fit(params, x_train, y_train)
    dump = model.booster_.dump_model()
    trees = []
    for info in dump["tree_info"]:
        tree = {key: [] for key in ("feature", "threshold", "left", "right", "value", "cover")}
        compact(info["tree_structure"], tree)
        trees.append(tree)

    # сдвиг шкалы к равному весу классов: шансы, выученные с весом scale_pos_weight, пересчитываем
    # к весу «дропперы весят столько же, сколько честные»
    share = y_train.mean()
    offset = math.log((1 - share) / share / params["scale_pos_weight"])

    sample = test.iloc[:CHECK_ROWS]
    raw = model.predict(sample[FEATURES], raw_score=True)
    shap = model.predict(sample[FEATURES], pred_contrib=True)
    exported = {
        "kind": "trees",
        "version": f"lgbm-monotone-synthetic-{SEED}",
        "features": FEATURES,
        "offset": offset,
        "trees": trees,
        "thresholds": {"soft": 0, "warn": 0, "hold": 0},
        "source": {
            "library": "lightgbm",
            "version": lgb.__version__,
            "params": params,
            "monotone_constraints": dict(zip(FEATURES, MONOTONE)),
            "monotone_constraints_method": "advanced",
            "optuna_trials": TRIALS,
        },
        "check": [
            {
                "features": {f: float(row[f]) for f in FEATURES},
                "logit": float(r + offset),
                "contributions": dict(zip(FEATURES, map(float, s[:-1]))),
                "expected": float(s[-1] + offset),
            }
            for (_, row), r, s in zip(sample.iterrows(), raw, shap)
        ],
    }
    out = ROOT / "lgbm-monotone.json"
    out.write_text(json.dumps(exported, separators=(",", ":")) + "\n", encoding="utf-8")
    nodes = sum(len(t["feature"]) for t in trees)
    print(f"Сохранено: ml/challenger/lgbm-monotone.json — деревьев {len(trees)}, узлов {nodes}, сдвиг шкалы {offset:.4f}, {out.stat().st_size // 1024} КБ")


if __name__ == "__main__":
    main()
