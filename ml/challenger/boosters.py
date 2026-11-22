"""XGBoost и CatBoost против рабочей модели (LightGBM) — на тех же данных и при тех же ограничениях.

Запуск (из корня проекта, после `npm run export-bench`):
    .venv/Scripts/python ml/challenger/boosters.py            # по 20 вариантов настроек на каждую
    .venv/Scripts/python ml/challenger/boosters.py --trials 5 # быстрый прогон

Условия одинаковые для всех: монотонные ограничения как у рабочей модели, Optuna подбирает настройки по
validation (цель та же, что в export_lgbm.py), итог считается на test, которого не видела ни одна модель.
Подбор идёт на первых 1,5 млн счетов train, итоговая модель учится на всём train.

Рядом — диагностическая модель: монотонная LightGBM, которая учится не на метках, а на точных вероятностях
идеальной модели. Это лучшее, что вообще можно получить при этих ограничениях; если рабочая модель с ней
совпадает, другой библиотекой ограничения не обойти.
"""

from __future__ import annotations

import argparse
import json
import time

import catboost as cb
import lightgbm as lgb
import numpy as np
import optuna
import xgboost as xgb

import export_lgbm
from benchmark import FEATURES, MONOTONE, ROOT, SEED, TARGET_FPR, evaluate, load, paired_bootstrap

optuna.logging.set_verbosity(optuna.logging.WARNING)
TUNE_ROWS = 1_500_000


def recall_at(scores: np.ndarray, y: np.ndarray, fpr: float) -> float:
    honest = np.sort(scores[y == 0])[::-1]
    return float((scores[y == 1] >= honest[int(len(honest) * fpr)]).mean())


def goal(scores: np.ndarray, y: np.ndarray) -> float:
    return 0.6 * recall_at(scores, y, TARGET_FPR["hold"]) + 0.4 * recall_at(scores, y, TARGET_FPR["warn"])


def xgb_model(params: dict) -> xgb.XGBClassifier:
    return xgb.XGBClassifier(
        tree_method="hist",
        monotone_constraints="(" + ",".join(str(m) for m in MONOTONE) + ")",
        n_jobs=-1,
        random_state=SEED,
        eval_metric="logloss",
        **params,
    )


def xgb_space(trial: optuna.Trial) -> dict:
    return {
        "n_estimators": trial.suggest_int("n_estimators", 100, 1500, log=True),
        "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
        "max_depth": trial.suggest_int("max_depth", 3, 10),
        "min_child_weight": trial.suggest_float("min_child_weight", 1, 200, log=True),
        "reg_lambda": trial.suggest_float("reg_lambda", 1e-3, 100, log=True),
        "subsample": trial.suggest_float("subsample", 0.5, 1.0),
        "scale_pos_weight": trial.suggest_float("scale_pos_weight", 1, 60, log=True),
        "max_bin": trial.suggest_categorical("max_bin", [256, 512, 1024]),
    }


def cb_model(params: dict) -> cb.CatBoostClassifier:
    return cb.CatBoostClassifier(
        monotone_constraints=MONOTONE,
        thread_count=-1,
        random_seed=SEED,
        verbose=False,
        allow_writing_files=False,
        **params,
    )


def cb_space(trial: optuna.Trial) -> dict:
    return {
        "iterations": trial.suggest_int("iterations", 100, 1500, log=True),
        "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
        "depth": trial.suggest_int("depth", 3, 8),
        "l2_leaf_reg": trial.suggest_float("l2_leaf_reg", 1e-2, 100, log=True),
        "scale_pos_weight": trial.suggest_float("scale_pos_weight", 1, 60, log=True),
        "border_count": trial.suggest_categorical("border_count", [128, 254]),
    }


def main() -> None:
    cli = argparse.ArgumentParser()
    cli.add_argument("--trials", type=int, default=20, help="сколько вариантов настроек на каждую библиотеку")
    args = cli.parse_args()

    data = load()
    parts = ("validation", "test", "stress", "collectors", *(f"perturb_{f}" for f in FEATURES))
    x_train = data["train"][FEATURES].to_numpy(dtype=float)
    y_train = data["train"]["is_dropper"].to_numpy()
    x = {p: data[p][FEATURES].to_numpy(dtype=float) for p in parts}
    yv = data["validation"]["is_dropper"].to_numpy()
    yt = data["test"]["is_dropper"].to_numpy()

    # рабочая модель — та, что сохранена в lgbm-monotone.json: те же настройки и то же зерно дают те же деревья
    best = json.loads((ROOT / "lgbm-monotone.json").read_text(encoding="utf-8"))["source"]["params"]
    started = time.time()
    working = export_lgbm.fit(best, data["train"][FEATURES], y_train)
    candidates: list[tuple[str, dict[str, np.ndarray], float | None, dict]] = [
        ("Рабочая: LightGBM монотонный, 7 признаков", {p: working.predict_proba(data[p][FEATURES])[:, 1] for p in parts}, time.time() - started, {"params": best}),
        # оценки модели сервиса, с которой выгружались данные (npm run export-bench), — прежняя, на 4 признаках
        ("Прежняя: LightGBM монотонный, 4 базовых признака", {p: data[p]["service"].to_numpy() for p in parts}, None, {}),
        ("Потолок: идеальная модель", {p: data[p]["ideal"].to_numpy() for p in parts}, None, {}),
    ]
    # цена ограничений: те же настройки без монотонности
    started = time.time()
    free = lgb.LGBMClassifier(objective="binary", subsample_freq=1, random_state=SEED, verbose=-1, n_jobs=-1,
                              **{k: v for k, v in best.items() if k != "monotone_constraints_method"}).fit(data["train"][FEATURES], y_train)
    candidates.append(("LightGBM без ограничений, те же настройки", {p: free.predict_proba(data[p][FEATURES])[:, 1] for p in parts}, time.time() - started, {}))

    for title, make, space in (("XGBoost монотонный", xgb_model, xgb_space), ("CatBoost монотонный", cb_model, cb_space)):
        started = time.time()

        def objective(trial: optuna.Trial) -> float:
            model = make(space(trial)).fit(x_train[:TUNE_ROWS], y_train[:TUNE_ROWS])
            value = goal(model.predict_proba(x["validation"])[:, 1], yv)
            print(f"  {title}, вариант {trial.number}: {value:.4f}", flush=True)
            return value

        study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=SEED))
        study.optimize(objective, n_trials=args.trials)
        model = make(study.best_params).fit(x_train, y_train)
        scores = {p: model.predict_proba(x[p])[:, 1] for p in parts}
        candidates.append((title, scores, time.time() - started, {"params": study.best_params, "optuna_trials": args.trials}))
        print(f"{title}: {time.time() - started:.0f} с, лучшая цель на validation {study.best_value:.4f}", flush=True)

    # диагностика: монотонная LightGBM на точных вероятностях идеальной модели
    started = time.time()
    params = {k: v for k, v in best.items() if k in ("num_leaves", "n_estimators", "learning_rate", "min_child_samples", "reg_lambda", "subsample", "max_bin", "path_smooth")}
    oracle = lgb.LGBMRegressor(objective="cross_entropy", subsample_freq=1, monotone_constraints=MONOTONE, monotone_constraints_method="advanced",
                               random_state=SEED, verbose=-1, n_jobs=-1, **params)
    oracle.fit(x_train, data["train"]["ideal"].to_numpy())
    candidates.append(("Диагностика: лучшее при ограничениях (учится на точных вероятностях)", {p: oracle.predict(x[p]) for p in parts}, time.time() - started, {}))

    rng = np.random.default_rng(SEED)
    service = candidates[0][1]
    results = []
    for name, scores, seconds, extra in candidates:
        row = evaluate(name, scores, data, seconds)
        if name != candidates[0][0]:
            row["diff_vs_service_found_ci"] = paired_bootstrap(scores, service, yv, yt, rng)
        row.update(extra)
        results.append(row)
    (ROOT / "results-boosters.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    pct = lambda v: f"{v * 100:5.1f}%"
    print(f"\n{'модель':70} {'ROC-AUC':>7}  warn   hold  стресс  сборщики  нарушения")
    for r in results:
        print(f"{r['model']:70} {r['roc_auc']:7.4f} {pct(r['warn_found'])} {pct(r['hold_found'])} {pct(r['hold_stress_found'])}   {pct(r['hold_collectors_found'])}    {pct(r['monotone_violations'])}")
        if "diff_vs_service_found_ci" in r:
            ci = r["diff_vs_service_found_ci"]
            print(f"{'':70} разница с рабочей, п.п.: warn [{ci['warn'][0]*100:+.1f}; {ci['warn'][1]*100:+.1f}]  hold [{ci['hold'][0]*100:+.1f}; {ci['hold'][1]*100:+.1f}]")


if __name__ == "__main__":
    main()
