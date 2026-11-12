// Генератор случайных чисел с фиксированным зерном: одинаковый запуск даёт одинаковые данные и метрики.

export type Rng = () => number

export function createRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function normal(rng: Rng): number {
  const u = Math.max(rng(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

export function lognormal(rng: Rng, median: number, sigma: number): number {
  return median * Math.exp(sigma * normal(rng))
}

export function uniform(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng()
}

export function poisson(rng: Rng, mean: number): number {
  const limit = Math.exp(-mean)
  let k = 0
  let p = rng()
  while (p > limit) {
    k++
    p *= rng()
  }
  return k
}

function gamma(rng: Rng, shape: number): number {
  if (shape < 1) return gamma(rng, shape + 1) * Math.pow(rng(), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    const x = normal(rng)
    const v = Math.pow(1 + c * x, 3)
    if (v <= 0) continue
    const u = rng()
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v
  }
}

// Доля от 0 до 1: чем больше a относительно b, тем ближе к 1.
export function beta(rng: Rng, a: number, b: number): number {
  const x = gamma(rng, a)
  return x / (x + gamma(rng, b))
}

export function pick<T>(rng: Rng, options: [T, number][]): T {
  const total = options.reduce((sum, [, weight]) => sum + weight, 0)
  let r = rng() * total
  for (const [value, weight] of options) {
    r -= weight
    if (r <= 0) return value
  }
  return options[options.length - 1]![0]
}
