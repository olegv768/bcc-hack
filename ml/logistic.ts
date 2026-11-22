// Логистическая регрессия методом Ньютона (IRLS) — для второй ступени, оценки перевода целиком.
// Признаков немного, строк — миллионы: каждая итерация — один проход по данным, сходится за 10–20.
// x — строки подряд (n × columns), y — метки 0/1. Возвращает [свободный член, веса признаков...].

export function fitLogistic(x: Float64Array, y: Uint8Array, columns: number): number[] {
  const d = columns + 1
  const n = y.length
  const w = new Float64Array(d)
  const row = new Float64Array(d)
  for (let iteration = 0; iteration < 50; iteration++) {
    const gradient = new Float64Array(d)
    const hessian = new Float64Array(d * d)
    for (let i = 0; i < n; i++) {
      row[0] = 1
      for (let j = 0; j < columns; j++) row[j + 1] = x[i * columns + j]!
      let z = 0
      for (let j = 0; j < d; j++) z += row[j]! * w[j]!
      const p = 1 / (1 + Math.exp(-z))
      const residual = y[i]! - p
      const s = p * (1 - p)
      for (let j = 0; j < d; j++) {
        gradient[j]! += residual * row[j]!
        const sj = s * row[j]!
        for (let k = j; k < d; k++) hessian[j * d + k]! += sj * row[k]!
      }
    }
    for (let j = 0; j < d; j++) for (let k = 0; k < j; k++) hessian[j * d + k] = hessian[k * d + j]!
    // крошечная добавка к диагонали — только от вырожденности, на веса она не влияет
    for (let j = 0; j < d; j++) hessian[j * d + j]! += 1e-9 * n
    const step = solve(hessian, gradient, d)
    let largest = 0
    for (let j = 0; j < d; j++) {
      w[j]! += step[j]!
      largest = Math.max(largest, Math.abs(step[j]!))
    }
    if (largest < 1e-10) break
  }
  return [...w]
}

// Решение системы a · s = b методом Гаусса с выбором главного элемента.
function solve(a: Float64Array, b: Float64Array, d: number): number[] {
  const m = Array.from({ length: d }, (_, j) => [...a.subarray(j * d, j * d + d), b[j]!])
  for (let c = 0; c < d; c++) {
    let pivot = c
    for (let r = c + 1; r < d; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[pivot]![c]!)) pivot = r
    ;[m[c], m[pivot]] = [m[pivot]!, m[c]!]
    for (let r = 0; r < d; r++) {
      if (r === c) continue
      const f = m[r]![c]! / m[c]![c]!
      for (let k = c; k <= d; k++) m[r]![k]! -= f * m[c]![k]!
    }
  }
  return m.map((row, j) => row[d]! / row[j]!)
}
