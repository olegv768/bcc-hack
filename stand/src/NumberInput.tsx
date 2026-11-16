import { useState } from 'react'

const format = (value: number) => (Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '')

// Поле для числа: пока его не редактируют, цифры разбиты на разряды («450 000»);
// при вводе показывается то, что набрал человек, чтобы курсор не прыгал.
export function NumberInput(props: {
  value: number
  onChange: (value: number) => void
  className?: string
  decimal?: boolean
  'aria-label'?: string
  'aria-invalid'?: boolean
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      type="text"
      inputMode={props.decimal ? 'decimal' : 'numeric'}
      autoComplete="off"
      aria-label={props['aria-label']}
      aria-invalid={props['aria-invalid']}
      value={text ?? format(props.value)}
      onFocus={() => setText(Number.isFinite(props.value) ? String(props.value).replace('.', ',') : '')}
      onBlur={() => setText(null)}
      onChange={(e) => {
        const raw = e.target.value
        setText(raw)
        const clean = raw.replace(/[\s  ]/g, '').replace(',', '.')
        const value = clean === '' ? NaN : Number(props.decimal ? clean : clean.replace(/\D/g, ''))
        props.onChange(value)
      }}
      className={props.className}
    />
  )
}
