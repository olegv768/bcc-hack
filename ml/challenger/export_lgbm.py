"""Рабочая модель: LightGBM с монотонными ограничениями → формат сервиса.

Запуск (из корня проекта, после `npm run export-bench`):
    .venv/Scripts/python ml/challenger/export_lgbm.py              # подбор настроек и обучение
    .venv/Scripts/python ml/challenger/export_lgbm.py --from-log   # без подбора: лучший вариант из data/tuning.log
    npm run train

Почему так. Сравнение претендентов (ml/challenger/benchmark.py) показало: LightGBM и InterpretML
находят больше дропперов, чем наш прежний бустинг, но без ограничений обе модели решают, что «очень
много незнакомых отправителей» — признак честного продавца. На синтетике это верно, а в жизни так
выглядит счёт-сборщик, на который несут деньги десятки жертв. Поэтому риск обязан не падать, когда
счёт моложе, незнакомых отправителей больше, вывод быстрее, общих устройств больше, счёт дольше
молчал, в него вошли с нового устройства или больше отправителей связаны с заблокированными счетами.
LightGBM выдерживает это ограничение почти без потерь, наш бустинг и InterpretML — с потерей 4–10 п.п.

Что делает скрипт:
1. Подбирает настройки Optuna на validation (test не трогает). Каждые 100 деревьев вариант
   проверяется на пятой части validation; заметно отстающий от середины уже посчитанных
   останавливается досрочно (после первых 10 вариантов и 300 деревьев).
2. Обучает модель на train с ограничениями монотонности (метод advanced).
3. Сохраняет деревья в компактном виде для service/src/trees.ts и контрольные счета: оценку и
   вклад каждого признака (SHAP) по самому LightGBM. ml/train.ts при импорте пересчитывает их своим
   кодом и останавливается, если хоть одно число разошлось.

Шкала риска. Модель учится с умеренным весом дропперов (его подбирает Optuna). Чтобы риск остался в
прежней шкале — как при равном весе классов, — к оценке прибавляется постоянный сдвиг. Порядок
счетов, пороги по доле ложных срабатываний и все метрики от этого не меняются, вклады признаков тоже.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
import optuna
import pandas as pd

ROOT = Path(__file__).resolve().parent
FEATURES = ["account_age_days", "unrelated_senders_7d", "fast_outflow_share_7d", "shared_device_accounts",
            "idle_days_before_inflow", "new_device_7d", "flagged_linked_senders_7d"]
MONOTONE = [-1, 1, 1, 1, 1, 1, 1]
SEED = 20261112
TARGET_FPR = {"warn": 0.02, "hold": 0.003}
CHECK_ROWS = 500
# Предел размера модели: всего листьев во всех деревьях. Больше — медленнее объяснение решения
# в сервисе (значения Шепли считаются по всем деревьям); с семью признаками 13 000 листьев — около 3 мс на запрос.
MAX_LEAVES = 30_000

optuna.logging.set_verbosity(optuna.logging.WARNING)


def recall_at(scores: np.ndarray, y: np.ndarray, fpr: float) -> float:
    honest = np.sort(scores[y == 0])[::-1]
    return float((scores[y == 1] >= honest[int(len(honest) * fpr)]).mean())


def fit(params: dict, x: pd.DataFrame, y: np.ndarray, seed: int = SEED, threads: int = -1, callbacks: list | None = None) -> lgb.LGBMClassifier:
    params = dict(params)
    method = params.pop("monotone_constraints_method", "advanced")
    return lgb.LGBMClassifier(
        objective="binary",
        subsample_freq=1,
        monotone_constraints=MONOTONE,
        monotone_constraints_method=method,
        random_state=seed,
        verbose=-1,
        n_jobs=threads,
        **params,
    ).fit(x, y, callbacks=callbacks)


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
    cli = argparse.ArgumentParser()
    cli.add_argument("--trials", type=int, default=120, help="сколько вариантов настроек пробует Optuna")
    cli.add_argument("--ensemble", type=int, default=0, help="0 — выбрать по проверочной выборке; N — усреднить N моделей")
    cli.add_argument("--jobs", type=int, default=1, help="сколько вариантов считать одновременно (ядра делятся между ними; на 12 ядрах один вариант на все ядра быстрее)")
    cli.add_argument("--from-log", action="store_true", help="не подбирать заново: взять лучший вариант из data/tuning.log (если подбор остановили раньше)")
    args = cli.parse_args()
    TRIALS = args.trials
    threads = max(1, (os.cpu_count() or 4) // args.jobs)
    log_path = ROOT / "data" / "tuning.log"
    logged: list[tuple[float, dict]] = []
    if args.from_log:
        lines = [line.split(None, 3) for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        TRIALS = len(lines)
        logged = [(float(v), json.loads(p)) for _, v, _, p in lines if v != "отсечён"]
    log = open(os.devnull, "w") if args.from_log else log_path.open("w", encoding="utf-8")
    df = pd.read_csv(ROOT / "data" / "bench.csv")
    train, validation, test = (df[df.split == s].reset_index(drop=True) for s in ("train", "validation", "test"))
    x_train, y_train = train[FEATURES], train["is_dropper"].to_numpy()
    yv = validation["is_dropper"].to_numpy()
    # для промежуточных проверок — каждый пятый счёт validation: быстро, а слабый вариант видно и так
    x_peek, y_peek = validation[FEATURES].iloc[::5], yv[::5]

    # больше всего ценим строгий порог «придержать»: там ошибка дороже
    def goal(sv: np.ndarray, y: np.ndarray = yv) -> float:
        return 0.6 * recall_at(sv, y, TARGET_FPR["hold"]) + 0.4 * recall_at(sv, y, TARGET_FPR["warn"])

    # Отсечение слабых вариантов: каждые 100 деревьев вариант проверяется на части validation, и если он
    # заметно хуже середины уже посчитанных на том же шаге, Optuna его останавливает.
    def pruning(trial: optuna.Trial):
        def callback(env) -> None:
            step = env.iteration + 1
            if step % 100:
                return
            value = goal(env.model.predict(x_peek, num_iteration=step, raw_score=True), y_peek)
            trial.report(value, step)
            if trial.should_prune():
                raise optuna.TrialPruned()

        return callback

    def objective(trial: optuna.Trial) -> float:
        leaves = trial.suggest_int("num_leaves", 7, 255, log=True)
        params = {
            "num_leaves": leaves,
            # размер модели ограничен: деревьев не больше, чем помещается в MAX_LEAVES листьев
            "n_estimators": trial.suggest_int("n_estimators", 100, min(3000, MAX_LEAVES // leaves), log=True),
            "learning_rate": trial.suggest_float("learning_rate", 0.005, 0.2, log=True),
            "min_child_samples": trial.suggest_int("min_child_samples", 20, 4000, log=True),
            "reg_lambda": trial.suggest_float("reg_lambda", 1e-3, 100, log=True),
            "subsample": trial.suggest_float("subsample", 0.5, 1.0),
            "scale_pos_weight": trial.suggest_float("scale_pos_weight", 1, 60, log=True),
            "max_bin": trial.suggest_categorical("max_bin", [255, 511, 1023]),
            "path_smooth": trial.suggest_float("path_smooth", 0, 50),
            "monotone_constraints_method": trial.suggest_categorical("monotone_constraints_method", ["intermediate", "advanced"]),
        }
        started = time.time()
        try:
            model = fit(params, x_train, y_train, threads=threads, callbacks=[pruning(trial)])
        except optuna.TrialPruned:
            log.write(f"{trial.number:4d} отсечён {time.time() - started:5.1f}s {json.dumps(params)}\n")
            log.flush()
            raise
        value = goal(model.predict(validation[FEATURES], raw_score=True))
        log.write(f"{trial.number:4d} {value:.4f} {time.time() - started:5.1f}s {json.dumps(params)}\n")
        log.flush()
        return value

    # первые 10 вариантов и первые 300 деревьев каждого не отсекаются
    pruner = optuna.pruners.MedianPruner(n_startup_trials=10, n_warmup_steps=300)
    study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=SEED), pruner=pruner)
    # первая попытка — прежние настройки, чтобы было с чем сравнивать
    study.enqueue_trial({
        "num_leaves": 28, "n_estimators": 400, "learning_rate": 0.0224, "min_child_samples": 87, "reg_lambda": 0.122,
        "subsample": 0.8715, "scale_pos_weight": 2.219, "max_bin": 255, "path_smooth": 0.0, "monotone_constraints_method": "advanced",
    })
    if logged:
        best_value, params = max(logged, key=lambda item: item[0])
        print(f"Из журнала подбора: {TRIALS} попыток (отсечено {TRIALS - len(logged)}), лучшая цель на validation {best_value:.4f}: {params}")
    else:
        study.optimize(objective, n_trials=TRIALS, n_jobs=args.jobs)
        params = study.best_params
        pruned = sum(t.state == optuna.trial.TrialState.PRUNED for t in study.trials)
        print(f"Optuna, {TRIALS} попыток (отсечено {pruned}), лучшая цель на validation {study.best_value:.4f}: {params}")

    # Ансамбль: несколько моделей с разными случайными выборками строк, оценки усредняются.
    # Среднее монотонных моделей монотонно, а значения Шепли среднего — среднее значений Шепли,
    # поэтому сервис считает ансамбль как одну модель: все деревья подряд, значения листьев делены на N.
    ensemble_size = args.ensemble
    models = [fit(params, x_train, y_train)]
    if not ensemble_size:
        best_goal, ensemble_size = goal(models[0].predict(validation[FEATURES], raw_score=True)), 1
        for n in (2, 3, 5):
            if params["num_leaves"] * params["n_estimators"] * n > MAX_LEAVES * 2:
                break
            while len(models) < n:
                models.append(fit(params, x_train, y_train, seed=SEED + len(models)))
            value = goal(np.mean([m.predict(validation[FEATURES], raw_score=True) for m in models], axis=0))
            print(f"Ансамбль из {n}: цель на validation {value:.4f}")
            if value > best_goal + 0.001:
                best_goal, ensemble_size = value, n
    while len(models) < ensemble_size:
        models.append(fit(params, x_train, y_train, seed=SEED + len(models)))
    models = models[:ensemble_size]
    print(f"Выбран ансамбль из {ensemble_size}")

    trees = []
    for model in models:
        for info in model.booster_.dump_model()["tree_info"]:
            tree = {key: [] for key in ("feature", "threshold", "left", "right", "value", "cover")}
            compact(info["tree_structure"], tree)
            tree["value"] = [v / ensemble_size for v in tree["value"]]
            trees.append(tree)

    # сдвиг шкалы к равному весу классов: шансы, выученные с весом scale_pos_weight, пересчитываем
    # к весу «дропперы весят столько же, сколько честные»
    share = y_train.mean()
    offset = math.log((1 - share) / share / params["scale_pos_weight"])

    sample = test.iloc[:CHECK_ROWS]
    raw = np.mean([m.predict(sample[FEATURES], raw_score=True) for m in models], axis=0)
    shap = np.mean([m.predict(sample[FEATURES], pred_contrib=True) for m in models], axis=0)
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
            "ensemble": ensemble_size,
            "train_accounts": int(len(train)),
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
