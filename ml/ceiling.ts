// Потолок качества на синтетических данных.
// Мы сами задали, как генератор создаёт счета (ml/generate.ts), поэтому можем точно посчитать,
// с какой вероятностью счёт с данными признаками — дроппер. Модель, которая знает эти формулы,
// лучше всех возможных: ни одна обученная модель по тем же четырём признакам её не обгонит.
// Сравнение с ней показывает, сколько ещё можно выжать настройкой, а сколько упирается в сами признаки.
//
// Распределения ниже повторяют ml/generate.ts; при изменении генератора их нужно менять вместе.

import type { RecipientFeatures } from '../service/src/features.ts'
import { DROPPER_SHARE } from './generate.ts'

// --- математика распределений ---

function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.001208650973866179, -0.000005395239384953]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let sum = 1.000000000190015
  for (const coefficient of c) sum += coefficient / ++y
  return -tmp + Math.log((2.5066282746310005 * sum) / x)
}

// доля распределения Beta(a, b) левее x
function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  const fraction = (xx: number, aa: number, bb: number) => {
    let c = 1
    let d = 1 - ((aa + bb) * xx) / (aa + 1)
    d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d)
    let h = d
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m
      let term = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2))
      d = 1 + term * d
      c = 1 + term / c
      d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d)
      c = Math.abs(c) < 1e-30 ? 1e-30 : c
      h *= d * c
      term = (-(aa + m) * (aa + bb + m) * xx) / ((aa + m2) * (aa + m2 + 1))
      d = 1 + term * d
      c = 1 + term / c
      d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d)
      c = Math.abs(c) < 1e-30 ? 1e-30 : c
      const delta = d * c
      h *= delta
      if (Math.abs(delta - 1) < 1e-10) break
    }
    return h
  }
  return x < (a + 1) / (a + b + 2) ? (front * fraction(x, a, b)) / a : 1 - (front * fraction(1 - x, b, a)) / b
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const tail = 0.3989422804014327 * Math.exp((-z * z) / 2) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? 1 - tail : tail
}

const poisson = (k: number, mean: number) => (k < 0 || !Number.isInteger(k) ? 0 : Math.exp(k * Math.log(mean) - mean - logGamma(k + 1)))

// --- вероятности значений признаков, как их выдаёт генератор (с округлением) ---

const lognormalCdf = (x: number, median: number, sigma: number) => (x <= 0 ? 0 : normalCdf(Math.log(x / median) / sigma))

// возраст «старого» счёта: логнормальный, зажатый в 45…6000 дней
function oldAge(age: number): number {
  if (age < 45 || age > 6000) return 0
  const low = age === 45 ? 0 : lognormalCdf(age - 0.5, 900, 0.9)
  const high = age === 6000 ? 1 : lognormalCdf(age + 0.5, 900, 0.9)
  return high - low
}

const uniformAge = (age: number, from: number, to: number) => Math.max(0, Math.min(age + 0.5, to) - Math.max(age - 0.5, from)) / (to - from)
const carefulAge = (age: number) => lognormalCdf(age + 0.5, 300, 0.8) - lognormalCdf(age - 0.5, 300, 0.8)

const outflow = (share: number, a: number, b: number) => betaCdf(share + 0.005, a, b) - betaCdf(share - 0.005, a, b)

// у продавцов среднее число отправителей само случайно — усредняем по нему
const sellerSenders = new Map<number, number>()
function sellerSendersProbability(k: number): number {
  if (!sellerSenders.has(k)) {
    let sum = 0
    const steps = 400
    for (let i = 0; i < steps; i++) {
      const z = -5 + (10 * (i + 0.5)) / steps
      sum += poisson(k, 12 * Math.exp(0.7 * z)) * 0.3989422804014327 * Math.exp((-z * z) / 2) * (10 / steps)
    }
    sellerSenders.set(k, sum)
  }
  return sellerSenders.get(k)!
}

type Likelihood = (age: number, senders: number, share: number, devices: number) => number

const HONEST: [number, Likelihood][] = [
  [0.72, (age, s, o, d) => oldAge(age) * poisson(s, 0.4) * outflow(o, 1.2, 8) * poisson(d, 0.25)],
  [0.1, (age, s, o, d) => uniformAge(age, 1, 60) * poisson(s, 0.8) * outflow(o, 1.5, 5) * poisson(d, 0.2)],
  [0.08, (age, s, o, d) => (0.25 * uniformAge(age, 5, 90) + 0.75 * oldAge(age)) * sellerSendersProbability(s) * outflow(o, 2, 6) * poisson(d, 0.3)],
  [0.07, (age, s, o, d) => oldAge(age) * poisson(s, 0.5) * outflow(o, 6, 2) * poisson(d, 0.2)],
  [0.03, (age, s, o, d) => oldAge(age) * poisson(s, 0.5) * outflow(o, 1.5, 6) * poisson(d - 1, 2)],
]

const DROPPERS: [number, Likelihood][] = [
  [0.5, (age, s, o, d) => uniformAge(age, 1, 30) * poisson(s - 1, 6) * outflow(o, 8, 1.5) * poisson(d, 2.5)],
  [0.25, (age, s, o, d) => oldAge(age) * poisson(s - 1, 5) * outflow(o, 7, 2) * poisson(d, 1.5)],
  [0.15, (age, s, o, d) => uniformAge(age, 1, 20) * poisson(s, 1) * outflow(o, 2, 3) * poisson(d, 1.5)],
  [0.1, (age, s, o, d) => carefulAge(age) * poisson(s, 2) * outflow(o, 3, 3) * poisson(d, 0.5)],
]

// Точная вероятность того, что счёт с такими признаками — дроппер.
export function idealScore(features: RecipientFeatures): number {
  const args = [features.account_age_days!, features.unrelated_senders_7d!, features.fast_outflow_share_7d!, features.shared_device_accounts!] as const
  const mix = (kinds: [number, Likelihood][]) => kinds.reduce((sum, [share, likelihood]) => sum + share * likelihood(...args), 0)
  const dropper = DROPPER_SHARE * mix(DROPPERS)
  const honest = (1 - DROPPER_SHARE) * mix(HONEST)
  return dropper + honest > 0 ? dropper / (dropper + honest) : 0
}
