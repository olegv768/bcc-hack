"""Обучение рабочей модели в InterpretML и перенос в формат сервиса (service/model/model.json).

Запуск (после `npm run export-bench`):
    .venv/Scripts/python ml/challenger/export_ebm.py
    npm run train -- --import ml/challenger/ebm-interpret.json

Почему InterpretML: это эталонная реализация объяснимого бустинга (Microsoft Research). Модель —
та же сумма таблиц, что у нашего сервиса: по таблице на признак и на каждую пару признаков. Поэтому
её можно перенести без изменения сервиса, а причины решений остаются такими же прозрачными.

Монотонность. На синтетике у честных продавцов много незнакомых отправителей, и модель без
ограничений решает, что «очень много незнакомых отправителей» — признак честного счёта. В жизни так
выглядит счёт-сборщик, на который несут деньги десятки жертв, и мошенник может этим воспользоваться.
Поэтому риск обязан не падать, когда счёт моложе, незнакомых отправителей больше, вывод быстрее и
общих устройств больше. Ограничение накладываем после обучения, как советует InterpretML: каждую
таблицу (и по признаку, и по паре признаков) приводим к монотонной изотонической регрессией с весами
клеток. Сумма монотонных таблиц монотонна, поэтому монотонна и вся оценка.

Что делает скрипт:
1. Обучает несколько вариантов на train с теми же весами классов, что ml/train.ts (шкала риска
   остаётся прежней, пороги стенда не ломаются), и сравнивает их на validation; test не трогает.
2. Проверяет каждый вариант на прочность: «сборщики» — дропперы с 15–40 незнакомыми отправителями;
   доля случаев, когда «ухудшение» признака снижает риск.
3. Сохраняет выбранный вариант в формате сервиса вместе с контрольными счетами: ml/train.ts при
   импорте пересчитывает их своим кодом и останавливается, если хоть один разошёлся.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
from interpret.glassbox import ExplainableBoostingClassifier
from sklearn.isotonic import IsotonicRegression

ROOT = Path(__file__).resolve().parent
FEATURES = ["account_age_days", "unrelated_senders_7d", "fast_outflow_share_7d", "shared_device_accounts"]
# моложе счёт, больше незнакомых отправителей, быстрее вывод, больше общих устройств — риск не падает
MONOTONE = {"account_age_days": -1, "unrelated_senders_7d": 1, "fast_outflow_share_7d": 1, "shared_device_accounts": 1}
SEED = 20261112
TARGET_FPR = {"warn": 0.02, "hold": 0.003}
CHECK_ROWS = 500
# монотонный вариант выбираем, если он теряет на validation не больше столько при пороге «придержать»
MONOTONE_MAX_LOSS = 0.02


def balanced_weights(y: np.ndarray) -> np.ndarray:
    positives = y.sum()
    return np.where(y == 1, len(y) / (2 * positives), len(y) / (2 * (len(y) - positives)))


# --- модель в формате сервиса и её оценка (повторяет service/src/model.ts) ---

def to_service_format(model: ExplainableBoostingClassifier, version: str) -> tuple[dict, list[np.ndarray]]:
    terms, weights = [], []
    for t, (features, scores) in enumerate(zip(model.term_features_, model.term_scores_)):
        level = len(features)
        edges = [np.asarray(model.bins_[f][min(level, len(model.bins_[f])) - 1], dtype=float) for f in features]
        # по каждой оси у InterpretML есть клетки «нет значения» (первая) и «неизвестно» (последняя);
        # сервис непереданный признак пропускает целиком, поэтому эти клетки не нужны
        inner = tuple(slice(1, len(e) + 2) for e in edges)
        table = np.array(scores[inner], dtype=float)
        assert table.shape == tuple(len(e) + 1 for e in edges)
        terms.append({"features": [FEATURES[f] for f in features], "edges": edges, "scores": table})
        weights.append(np.array(model.bin_weights_[t][inner], dtype=float))
    return {"version": version, "bias": float(model.intercept_[0]), "terms": terms}, weights


def logits(service: dict, df: pd.DataFrame) -> np.ndarray:
    out = np.full(len(df), service["bias"])
    for term in service["terms"]:
        index = tuple(np.searchsorted(e, df[f].to_numpy(dtype=float), side="right") for f, e in zip(term["features"], term["edges"]))
        out += term["scores"][index]
    return out


def isotonic(values: np.ndarray, weights: np.ndarray, direction: int) -> np.ndarray:
    x = np.arange(len(values))
    return IsotonicRegression(increasing=direction > 0).fit(x, values, sample_weight=weights + 1e-9).predict(x)


def monotonize(service: dict, weights: list[np.ndarray]) -> dict:
    """Каждую таблицу делаем монотонной по ограниченным осям, затем снова центрируем."""
    result = {"version": service["version"] + "-mono", "bias": service["bias"], "terms": []}
    for term, w in zip(service["terms"], weights):
        table = term["scores"].copy()
        directions = [MONOTONE.get(f, 0) for f in term["features"]]
        # для пары — поочерёдно по строкам и столбцам, пока таблица не перестанет меняться
        for _ in range(60 if table.ndim > 1 else 1):
            before = table.copy()
            for axis, direction in enumerate(directions):
                if not direction:
                    continue
                moved = np.moveaxis(table, axis, -1)
                moved_w = np.moveaxis(w, axis, -1)
                flat, flat_w = moved.reshape(-1, moved.shape[-1]), moved_w.reshape(-1, moved_w.shape[-1])
                fixed = np.vstack([isotonic(row, row_w, direction) for row, row_w in zip(flat, flat_w)])
                table = np.moveaxis(fixed.reshape(moved.shape), -1, axis)
            if np.abs(table - before).max() < 1e-9:
                break
        # центрирование: средний вклад таблицы — ноль, иначе «признак не передан» перестанет значить «как у среднего»
        mean = float((table * w).sum() / w.sum()) if w.sum() else 0.0
        result["bias"] += mean
        result["terms"].append({**term, "scores": table - mean})
    return result


# --- проверки ---

def recall_at(scores: np.ndarray, y: np.ndarray, honest_reference: np.ndarray, fpr: float) -> float:
    threshold = np.sort(honest_reference)[::-1][int(len(honest_reference) * fpr)]
    return float((scores[y == 1] >= threshold).mean())


def violations(service: dict, df: pd.DataFrame) -> float:
    """Доля пар «счёт и тот же счёт с ухудшенным признаком», где риск заметно упал."""
    base = logits(service, df)
    steps = {"account_age_days": -0.5, "unrelated_senders_7d": 3, "fast_outflow_share_7d": 0.15, "shared_device_accounts": 2}
    worse = 0
    for f, step in steps.items():
        changed = df.copy()
        changed[f] = changed[f] * (1 + step) if f == "account_age_days" else changed[f] + step
        if f == "fast_outflow_share_7d":
            changed[f] = changed[f].clip(0, 1)
        worse += int((logits(service, changed) < base - 0.05).sum())
    return worse / (len(df) * len(steps))


def collectors(df: pd.DataFrame, rng: np.random.Generator) -> pd.DataFrame:
    """Дропперы из test, которые стали «сборщиками»: на счёт несут деньги 15–40 незнакомых людей."""
    droppers = df[df.is_dropper == 1].copy()
    droppers["unrelated_senders_7d"] = rng.integers(15, 41, size=len(droppers))
    return droppers


def report(name: str, service: dict, data: dict[str, pd.DataFrame], rng: np.random.Generator) -> dict:
    v, s = data["validation"], data["stress"]
    yv = v.is_dropper.to_numpy()
    sv = logits(service, v)
    honest_v = sv[yv == 0]
    hold = lambda scores, y: recall_at(scores, y, honest_v, TARGET_FPR["hold"])
    warn = lambda scores, y: recall_at(scores, y, honest_v, TARGET_FPR["warn"])
    attack = collectors(data["test"], rng)
    return {
        "variant": name,
        "validation_warn": warn(sv, yv),
        "validation_hold": hold(sv, yv),
        "stress_hold": hold(logits(service, s), s.is_dropper.to_numpy()),
        "collectors_hold": hold(logits(service, attack), np.ones(len(attack), dtype=int)),
        "monotone_violations": violations(service, data["test"].sample(4000, random_state=SEED)),
    }


def main() -> None:
    df = pd.read_csv(ROOT / "data" / "bench.csv")
    data = {name: part.reset_index(drop=True) for name, part in df.groupby("split")}
    x_train, y_train = data["train"][FEATURES], data["train"]["is_dropper"].to_numpy()
    rng = np.random.default_rng(SEED)

    t = time.time()
    model = ExplainableBoostingClassifier(interactions=6, max_interaction_bins=96, random_state=SEED, n_jobs=-1)
    model.fit(x_train, y_train, sample_weight=balanced_weights(y_train))
    print(f"InterpretML EBM обучена за {time.time() - t:.0f} с")
    plain, weights = to_service_format(model, f"ebm-interpret-synthetic-{SEED}")
    mono = monotonize(plain, weights)

    rows = [report("без ограничений", plain, data, rng), report("монотонная", mono, data, rng)]
    print(f"\n{'вариант':18} validation: warn  hold   стресс hold  сборщики hold  нарушения монотонности")
    for r in rows:
        print(
            f"{r['variant']:18} {r['validation_warn'] * 100:15.1f}% {r['validation_hold'] * 100:5.1f}%"
            f" {r['stress_hold'] * 100:11.1f}% {r['collectors_hold'] * 100:13.1f}% {r['monotone_violations'] * 100:21.2f}%"
        )

    loss = rows[0]["validation_hold"] - rows[1]["validation_hold"]
    chosen = mono if loss <= MONOTONE_MAX_LOSS else plain
    print(f"\nПотеря монотонной на validation при «придержать»: {loss * 100:.1f} п.п. → выбрана: {'монотонная' if chosen is mono else 'без ограничений'}")

    sample = data["test"].iloc[:CHECK_ROWS]
    check_logits = logits(chosen, sample)
    if chosen is plain:  # без доработки наша оценка обязана совпасть с самой библиотекой
        assert np.abs(check_logits - model.decision_function(sample[FEATURES])).max() < 1e-9

    exported = {
        "version": chosen["version"],
        "bias": round(chosen["bias"], 6),
        "terms": [{"features": t["features"], "edges": [e.tolist() for e in t["edges"]], "scores": [round(float(x), 6) for x in t["scores"].ravel()]} for t in chosen["terms"]],
        "thresholds": {"soft": 0, "warn": 0, "hold": 0},
        "source": {
            "library": "interpret",
            "version": __import__("interpret").__version__,
            "params": {"interactions": 6, "max_interaction_bins": 96},
            "class_weight": "balanced",
            "monotone": MONOTONE if chosen is mono else None,
        },
        "robustness": rows,
        "check": [
            {"features": {f: (None if pd.isna(row[f]) else float(row[f])) for f in FEATURES}, "logit": float(l)}
            for (_, row), l in zip(sample.iterrows(), check_logits)
        ],
    }
    out = ROOT / "ebm-interpret.json"
    out.write_text(json.dumps(exported, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Сохранено: ml/challenger/ebm-interpret.json — таблиц {len(exported['terms'])}")


if __name__ == "__main__":
    main()
