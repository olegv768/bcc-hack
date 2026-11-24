"""Сколько стоит каждое ограничение монотонности на семи признаках.

Запуск (из корня проекта, после `npm run export-bench`):
    .venv/Scripts/python ml/challenger/constraints.py

Все модели — LightGBM с настройками рабочей модели (из ml/challenger/lgbm-monotone.json), обучение на
train, пороги на validation (2% и 0,3% честных выше порога), итог на test. Печатает:
- потолок — идеальную модель;
- модель с ограничениями на все семь признаков;
- «лучшую возможную» с теми же ограничениями: та же LightGBM, обученная на точных вероятностях
  идеальной модели вместо меток (диагностика: в жизни точных вероятностей нет);
- модель без ограничений;
- модели, где снято одно ограничение, и вариант «ограничение только на отправителей».
Около 30 минут на 12 ядрах.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark as b  # noqa: E402

ROOT = Path(__file__).resolve().parent
ALL = [-1, 1, 1, 1, 1, 1, 1]  # «хуже» для каждого признака: моложе счёт, больше отправителей и т. д.


def main() -> None:
    source = json.loads((ROOT / "lgbm-monotone.json").read_text(encoding="utf-8"))["source"]
    params = {k: v for k, v in source["params"].items() if k != "monotone_constraints_method"}
    data = b.load()
    parts = tuple(p for p in ("validation", "test", "stress", "collectors", *(f"perturb_{f}" for f in b.FEATURES)) if p in data)
    x, y = data["train"][b.FEATURES], data["train"]["is_dropper"].to_numpy()
    ideal = data["train"]["ideal"].to_numpy()

    def per_feature(scores) -> str:
        base = b.logit(scores["test"])
        out = []
        for f in b.FEATURES:
            part = f"perturb_{f}"
            bad = (b.logit(scores[part]) < base[data[part]["base"].to_numpy()] - 0.05).mean()
            if bad > 0:
                out.append(f"{f} {bad * 100:.1f}%")
        return ", ".join(out) or "—"

    def show(name: str, scores) -> None:
        # нарушения считаются по всем семи признакам: «счёт вдвое моложе» тоже входит
        r = b.evaluate(name, scores, data, None)
        print(f"{name:46s} AUC {r['roc_auc']:.4f}  предупредить {r['warn_found'] * 100:5.2f}%  приостановить {r['hold_found'] * 100:5.2f}%  "
              f"тактика {r['hold_stress_found'] * 100:5.2f}%  сборщики {r['hold_collectors_found'] * 100:5.2f}%  "
              f"нарушения {r['monotone_violations'] * 100:4.2f}% ({per_feature(scores)})", flush=True)

    def train(name: str, monotone: list[int] | None, soft: bool = False) -> None:
        started = time.time()
        extra = {"monotone_constraints": monotone, "monotone_constraints_method": "advanced"} if monotone else {}
        if soft:
            # cross_entropy принимает метки от 0 до 1 — это и есть точные вероятности
            soft_params = {k: v for k, v in params.items() if k != "scale_pos_weight"}
            model = lgb.LGBMRegressor(objective="cross_entropy", subsample_freq=1, random_state=b.SEED, verbose=-1, **soft_params, **extra).fit(x, ideal)
            scores = {p: model.predict(data[p][b.FEATURES]) for p in parts}
        else:
            model = lgb.LGBMClassifier(objective="binary", subsample_freq=1, random_state=b.SEED, verbose=-1, **params, **extra).fit(x, y)
            scores = {p: model.predict_proba(data[p][b.FEATURES])[:, 1] for p in parts}
        show(f"{name} ({time.time() - started:.0f} с)", scores)

    show("потолок: идеальная модель", {p: data[p]["ideal"].to_numpy() for p in parts})
    train("ограничения на все семь", ALL)
    train("лучшая возможная с теми же ограничениями", ALL, soft=True)
    train("без ограничений", None)
    for i, feature in enumerate(b.FEATURES):
        monotone = list(ALL)
        monotone[i] = 0
        train(f"без ограничения: {feature}", monotone)
    only_senders = [0] * len(ALL)
    only_senders[1] = 1
    train("ограничение только на отправителей", only_senders)


if __name__ == "__main__":
    main()
