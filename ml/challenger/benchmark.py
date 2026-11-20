"""Сравнение текущей модели с моделями-претендентами на промышленных библиотеках.

Запуск (из корня проекта, после `npm run export-bench`):
    python -m venv .venv
    .venv/Scripts/python -m pip install -r ml/challenger/requirements.txt   (Windows)
    .venv/Scripts/python ml/challenger/benchmark.py

Так в банках проверяют рабочую модель: рядом обучают «претендентов» другими методами на тех же
данных и тем же делением, и рабочую модель меняют, только если претендент заметно и устойчиво лучше.

Все модели оцениваются одинаково:
- обучение на train, подбор настроек и порогов на validation, итог на test, которого никто не видел;
- пороги — как у сервиса: «предупредить» при 2% честных выше порога, «придержать» при 0,3%;
- разброс метрик — бутстрэп; разница с текущей моделью — парный бутстрэп на одних и тех же счетах;
- устойчивость — выборка stress, где дропперы сменили тактику, пороги прежние;
- калибровка — насколько «риск 80%» значит «8 из 10 таких счетов — дропперы» (после изотонической
  калибровки на validation);
- «сборщики» — дропперы из test, на которых несут деньги 15–40 незнакомых людей (так выглядит
  счёт-сборщик; в обучающих данных таких нет — проверка того, как модель ведёт себя вне них);
- нарушения логики — доля случаев, когда «ухудшение» одного признака (счёт вдвое моложе, +3
  незнакомых отправителя, +15 п.п. быстрого вывода, +2 общих устройства) заметно снижает риск.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
import optuna
import pandas as pd
from interpret.glassbox import ExplainableBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent
FEATURES = ["account_age_days", "unrelated_senders_7d", "fast_outflow_share_7d", "shared_device_accounts"]
# Направление риска, которого ждёт аналитик: моложе счёт, больше незнакомых отправителей,
# быстрее вывод, больше общих устройств — риск не должен падать.
MONOTONE = [-1, 1, 1, 1]
TARGET_FPR = {"warn": 0.02, "hold": 0.003}
BOOTSTRAP = 400
SEED = 20261112

optuna.logging.set_verbosity(optuna.logging.WARNING)


def load() -> dict[str, pd.DataFrame]:
    df = pd.read_csv(ROOT / "data" / "bench.csv")
    return {name: part.reset_index(drop=True) for name, part in df.groupby("split")}


def log_features(df: pd.DataFrame) -> np.ndarray:
    x = df[FEATURES].to_numpy(dtype=float)
    x[:, [0, 1, 3]] = np.log1p(np.maximum(0, x[:, [0, 1, 3]]))
    return x


def thresholds_for(scores_validation: np.ndarray, y_validation: np.ndarray) -> dict[str, float]:
    honest = np.sort(scores_validation[y_validation == 0])[::-1]
    return {name: float(honest[int(len(honest) * fpr)]) for name, fpr in TARGET_FPR.items()}


def recall_fpr(scores: np.ndarray, y: np.ndarray, threshold: float) -> tuple[float, float]:
    above = scores >= threshold
    return float(above[y == 1].mean()), float(above[y == 0].mean())


def ece(probabilities: np.ndarray, y: np.ndarray, bins: int = 15) -> float:
    """Средняя ошибка калибровки по корзинам равной численности."""
    order = np.argsort(probabilities)
    error = 0.0
    for chunk in np.array_split(order, bins):
        error += len(chunk) / len(y) * abs(probabilities[chunk].mean() - y[chunk].mean())
    return float(error)


def recall_at_validation_threshold(model_scores_validation, y_validation, scores_test, y_test, fpr):
    honest = np.sort(model_scores_validation[y_validation == 0])[::-1]
    return recall_fpr(scores_test, y_test, honest[int(len(honest) * fpr)])[0]


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return np.log(p / (1 - p))


def violations(scores: dict[str, np.ndarray], data: dict[str, pd.DataFrame]) -> float:
    base = logit(scores["test"])
    bad = total = 0
    for f in FEATURES:
        part = f"perturb_{f}"
        changed = logit(scores[part])
        original = base[data[part]["base"].to_numpy()]
        bad += int((changed < original - 0.05).sum())
        total += len(changed)
    return bad / total


def evaluate(name: str, scores: dict[str, np.ndarray], data: dict[str, pd.DataFrame], seconds: float | None) -> dict:
    yv, yt, ys = (data[p]["is_dropper"].to_numpy() for p in ("validation", "test", "stress"))
    th = thresholds_for(scores["validation"], yv)
    calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(scores["validation"], yv)
    p_test = calibrator.predict(scores["test"])
    result = {
        "model": name,
        "train_seconds": round(seconds, 1) if seconds is not None else None,
        "roc_auc": roc_auc_score(yt, scores["test"]),
        "pr_auc": average_precision_score(yt, scores["test"]),
        "brier_calibrated": brier_score_loss(yt, p_test),
        "ece_calibrated": ece(p_test, yt),
        "ece_raw": ece(np.clip(scores["test"], 0, 1), yt),
    }
    for level, threshold in th.items():
        found, false_alarm = recall_fpr(scores["test"], yt, threshold)
        stress_found, stress_false = recall_fpr(scores["stress"], ys, threshold)
        result[f"{level}_found"] = found
        result[f"{level}_honest_flagged"] = false_alarm
        result[f"{level}_stress_found"] = stress_found
        result[f"{level}_stress_honest_flagged"] = stress_false
        result[f"{level}_collectors_found"] = float((scores["collectors"] >= threshold).mean())
    result["monotone_violations"] = violations(scores, data)
    return result


def paired_bootstrap(scores_a, scores_b, yv, yt, rng) -> dict[str, list[float]]:
    """Разница «претендент минус текущая» в доле найденных дропперов: 95% интервал."""
    th_a = thresholds_for(scores_a["validation"], yv)
    th_b = thresholds_for(scores_b["validation"], yv)
    out = {}
    for level in TARGET_FPR:
        hits_a = (scores_a["test"] >= th_a[level]).astype(float)
        hits_b = (scores_b["test"] >= th_b[level]).astype(float)
        positives = np.flatnonzero(yt == 1)
        diffs = []
        for _ in range(BOOTSTRAP):
            sample = rng.choice(positives, size=len(positives), replace=True)
            diffs.append(hits_a[sample].mean() - hits_b[sample].mean())
        out[level] = [float(np.quantile(diffs, 0.025)), float(np.quantile(diffs, 0.975))]
    return out


def main() -> None:
    data = load()
    yt_train = data["train"]["is_dropper"].to_numpy()
    yv = data["validation"]["is_dropper"].to_numpy()
    yt = data["test"]["is_dropper"].to_numpy()
    parts = ("validation", "test", "stress", "collectors", *(f"perturb_{f}" for f in FEATURES))
    candidates: list[tuple[str, dict[str, np.ndarray], float | None, dict]] = []

    # --- текущая модель и идеал (оценки посчитаны в TypeScript) ---
    candidates.append(("Прежняя: наш объяснимый бустинг (TypeScript)", {p: data[p]["current"].to_numpy() for p in parts}, None, {}))
    candidates.append(("Идеальная модель (потолок)", {p: data[p]["ideal"].to_numpy() for p in parts}, None, {}))

    x_train = log_features(data["train"])
    x = {p: log_features(data[p]) for p in parts}
    raw_train = data["train"][FEATURES].to_numpy(dtype=float)
    raw = {p: data[p][FEATURES].to_numpy(dtype=float) for p in parts}

    # --- логистическая регрессия: база, с которой начинают ---
    t = time.time()
    lr = LogisticRegression(max_iter=2000, class_weight="balanced").fit(x_train, yt_train)
    candidates.append(("Логистическая регрессия (scikit-learn)", {p: lr.predict_proba(x[p])[:, 1] for p in parts}, time.time() - t, {}))

    # --- LightGBM: стандарт индустрии для табличных данных; настройки подбирает Optuna ---
    def lgb_fit(params: dict, monotone: bool) -> lgb.LGBMClassifier:
        model = lgb.LGBMClassifier(
            objective="binary",
            n_estimators=params["n_estimators"],
            learning_rate=params["learning_rate"],
            num_leaves=params["num_leaves"],
            min_child_samples=params["min_child_samples"],
            reg_lambda=params["reg_lambda"],
            subsample=params["subsample"],
            subsample_freq=1,
            colsample_bytree=1.0,
            scale_pos_weight=params["scale_pos_weight"],
            monotone_constraints=MONOTONE if monotone else None,
            monotone_constraints_method="advanced" if monotone else None,
            random_state=SEED,
            verbose=-1,
            n_jobs=-1,
        )
        return model.fit(raw_train, yt_train)

    def tune(monotone: bool) -> tuple[dict, int]:
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
            sv = lgb_fit(params, monotone).predict_proba(raw["validation"])[:, 1]
            # цель — найти больше дропперов при строгом пороге «придержать», где ошибка дороже всего
            honest = np.sort(sv[yv == 0])[::-1]
            hold = recall_fpr(sv, yv, honest[int(len(honest) * TARGET_FPR["hold"])])[0]
            warn = recall_fpr(sv, yv, honest[int(len(honest) * TARGET_FPR["warn"])])[0]
            return 0.6 * hold + 0.4 * warn

        study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=SEED))
        study.optimize(objective, n_trials=40)
        return study.best_params, len(study.trials)

    for monotone, title in ((False, "LightGBM + Optuna"), (True, "LightGBM + Optuna, монотонный")):
        t = time.time()
        params, trials = tune(monotone)
        model = lgb_fit(params, monotone)
        candidates.append((title, {p: model.predict_proba(raw[p])[:, 1] for p in parts}, time.time() - t, {"params": params, "optuna_trials": trials}))

    # --- InterpretML EBM: эталонная реализация того же метода, что у нас (Microsoft Research) ---
    t = time.time()
    ebm = ExplainableBoostingClassifier(interactions=6, random_state=SEED, n_jobs=-1)
    ebm.fit(pd.DataFrame(raw_train, columns=FEATURES), yt_train)
    candidates.append(("InterpretML EBM (Microsoft)", {p: ebm.predict_proba(pd.DataFrame(raw[p], columns=FEATURES))[:, 1] for p in parts}, time.time() - t, {}))

    # та же модель, приведённая к монотонной после обучения, как советует InterpretML (export_ebm.py)
    import export_ebm

    service, weights = export_ebm.to_service_format(ebm, "ebm")
    mono = export_ebm.monotonize(service, weights)
    candidates.append(("InterpretML EBM, монотонная после обучения", {p: 1 / (1 + np.exp(-export_ebm.logits(mono, data[p]))) for p in parts}, None, {}))

    # --- итог ---
    rng = np.random.default_rng(SEED)
    current = candidates[0][1]
    results = []
    for name, scores, seconds, extra in candidates:
        row = evaluate(name, scores, data, seconds)
        if name != candidates[0][0]:
            row["diff_vs_current_found_ci"] = paired_bootstrap(scores, current, yv, yt, rng)
        row.update(extra)
        results.append(row)

    (ROOT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    pct = lambda v: f"{v * 100:5.1f}%"
    print(f"{'модель':48} {'ROC-AUC':>7} {'PR-AUC':>6}  warn: найдено/ложных  hold: найдено/ложных  стресс  сборщики  нарушения")
    for r in results:
        print(
            f"{r['model']:48} {r['roc_auc']:7.4f} {r['pr_auc']:6.3f}  {pct(r['warn_found'])} / {pct(r['warn_honest_flagged'])}"
            f"     {pct(r['hold_found'])} / {pct(r['hold_honest_flagged'])}  {pct(r['hold_stress_found'])}   {pct(r['hold_collectors_found'])}    {pct(r['monotone_violations'])}"
        )
        if "diff_vs_current_found_ci" in r:
            ci = r["diff_vs_current_found_ci"]
            print(f"{'':48} разница с текущей, п.п.: warn [{ci['warn'][0]*100:+.1f}; {ci['warn'][1]*100:+.1f}]  hold [{ci['hold'][0]*100:+.1f}; {ci['hold'][1]*100:+.1f}]")


if __name__ == "__main__":
    main()
