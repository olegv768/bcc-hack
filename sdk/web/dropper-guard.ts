// Клиентский модуль для веб-части приложения (WebView, гибридное приложение, интернет-банк).
// Делает две вещи:
//   1. callSignal() и remoteAccessSignal() — отдают признаки «клиент на звонке» и «телефоном управляют
//      удалённо», приложение кладёт их в запрос перевода;
//   2. showWarning() — показывает предупреждение, которое вернул сервис оценки, и ждёт выбор клиента.
// Модуль сам никуда не ходит по сети и ничего не хранит.

export type Action = 'allow' | 'warn' | 'hold'
export type Lang = 'ru' | 'kk' | 'en'
export type ClientMessage = { title: string; body: string }
export type Choice = 'cancel' | 'proceed'

// В браузере узнать о звонке нельзя, поэтому признак даёт нативная часть приложения
// (Android: sdk/android/CallSignal.kt, iOS: sdk/ios/CallSignal.swift) через мост.
// Если мост не подключён, возвращаем null — сервис оценит перевод без этого признака.
export function callSignal(bridge?: () => boolean | null): boolean | null {
  try {
    return bridge ? bridge() : null
  } catch {
    return null
  }
}

// То же для признака «телефоном могут управлять удалённо» (Android: sdk/android/RemoteAccessSignal.kt).
export function remoteAccessSignal(bridge?: () => boolean | null): boolean | null {
  return callSignal(bridge)
}

const BUTTONS: Record<Lang, { cancel: string; proceed: string; close: string }> = {
  ru: { cancel: 'Отменить перевод', proceed: 'Всё равно перевести', close: 'Понятно' },
  kk: { cancel: 'Аударымнан бас тарту', proceed: 'Бәрібір аудару', close: 'Түсінікті' },
  en: { cancel: 'Cancel transfer', proceed: 'Send anyway', close: 'OK' },
}

// Сколько секунд кнопка «Всё равно перевести» недоступна: пауза, чтобы человек успел прочитать текст.
const PROCEED_DELAY_SECONDS = 5

const STYLES = `
.dg-backdrop{position:absolute;inset:0;background:rgba(20,20,18,.45);display:flex;align-items:flex-end;z-index:10}
.dg-sheet{width:100%;background:#fff;color:#16150f;border-radius:16px 16px 0 0;padding:20px 18px 18px;font:15px/1.45 system-ui,sans-serif;box-sizing:border-box}
.dg-mark{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px;margin-bottom:10px}
.dg-warn .dg-mark{background:#fdecc0;color:#5b3d00}
.dg-hold .dg-mark{background:#f9dcdc;color:#7a1414}
.dg-title{font-size:18px;font-weight:650;line-height:1.25;margin:0 0 8px}
.dg-body{margin:0 0 16px}
.dg-button{display:block;width:100%;min-height:46px;border-radius:10px;border:1px solid #16150f;font:inherit;font-weight:600;cursor:pointer}
.dg-primary{background:#16150f;color:#fff}
.dg-secondary{background:transparent;color:#16150f;border-color:#c9c7bd;margin-top:8px}
.dg-secondary:disabled{color:#8d8b82;cursor:default}
.dg-button:focus-visible{outline:3px solid #2a78d6;outline-offset:2px}
`

const MARKS: Record<Lang, { warn: string; hold: string }> = {
  ru: { warn: 'Предупреждение', hold: 'Перевод приостановлен' },
  kk: { warn: 'Ескерту', hold: 'Аударым тоқтатылды' },
  en: { warn: 'Warning', hold: 'Transfer on hold' },
}

// Показывает предупреждение внутри container (у него должно быть position: relative).
// warn — клиент может отменить перевод или продолжить после паузы; hold — только закрыть, перевод не уходит.
export function showWarning(
  container: HTMLElement,
  options: { action: Exclude<Action, 'allow'>; message: ClientMessage; lang?: Lang },
): Promise<Choice> {
  const lang = options.lang ?? 'ru'
  const doc = container.ownerDocument

  if (!doc.getElementById('dg-styles')) {
    const style = doc.createElement('style')
    style.id = 'dg-styles'
    style.textContent = STYLES
    doc.head.append(style)
  }

  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const node = doc.createElement(tag)
    node.className = className
    if (text) node.textContent = text // только textContent: текст сервиса не исполняется как разметка
    return node
  }

  const backdrop = element('div', 'dg-backdrop dg-' + options.action)
  const sheet = element('div', 'dg-sheet')
  sheet.setAttribute('role', 'alertdialog')
  sheet.setAttribute('aria-modal', 'true')
  const title = element('h2', 'dg-title', options.message.title)
  title.id = 'dg-title'
  sheet.setAttribute('aria-labelledby', title.id)
  sheet.append(element('span', 'dg-mark', MARKS[lang][options.action]), title, element('p', 'dg-body', options.message.body))

  const cancel = element('button', 'dg-button dg-primary', options.action === 'hold' ? BUTTONS[lang].close : BUTTONS[lang].cancel)
  cancel.type = 'button'
  sheet.append(cancel)
  backdrop.append(sheet)
  container.append(backdrop)
  cancel.focus()

  return new Promise<Choice>((resolve) => {
    let timer: ReturnType<typeof setInterval> | undefined
    const finish = (choice: Choice) => {
      clearInterval(timer)
      backdrop.remove()
      resolve(choice)
    }
    cancel.addEventListener('click', () => finish('cancel'))

    if (options.action === 'warn') {
      const proceed = element('button', 'dg-button dg-secondary')
      proceed.type = 'button'
      proceed.disabled = true
      let left = PROCEED_DELAY_SECONDS
      const label = () => (proceed.textContent = left > 0 ? `${BUTTONS[lang].proceed} (${left})` : BUTTONS[lang].proceed)
      label()
      timer = setInterval(() => {
        left--
        label()
        if (left <= 0) {
          proceed.disabled = false
          clearInterval(timer)
        }
      }, 1000)
      proceed.addEventListener('click', () => finish('proceed'))
      sheet.append(proceed)
    }
  })
}
