// Защита на стороне получателя: POST /incoming. Банк вызывает его, когда на счёт его клиента
// приходит перевод, в том числе из другого банка.
//
// Зачем: в «треугольнике» обманутый покупатель платит честному продавцу криптовалюты, и тот,
// увидев деньги, отпускает криптовалюту мошеннику. Остановить схему проще всего у получателя:
// предупредить его до того, как он отпустит криптовалюту или товар. Для межбанковских переводов
// банк-получатель узнаёт о проблеме из Антифрод-центра Национального банка: туда банк отправителя
// передаёт отметку о мошеннической операции.

import { Router } from 'express'
import { z } from 'zod'
import type { createAlertQueue } from './alerts.ts'
import { PURPOSES } from './features.ts'
import type { Lang } from './texts.ts'

export type IncomingAction = 'none' | 'notify' | 'hold_credit'

// метка алертов проверки поступления: по ней панель и граф отличают их от алертов оценки перевода
export const INCOMING_VERSION = 'incoming-rules-1'

const IncomingRequest = z.object({
  transfer_id: z.string().min(1).max(100).optional(),
  lang: z.enum(['ru', 'kk', 'en']).default('ru'),
  amount: z.number().positive().max(1e12),
  recipient: z.object({
    account_id: z.string().min(1).max(100),
    client_ref: z.string().min(1).max(100).optional(),
    p2p_trader_profile: z.boolean().nullable().default(null),
  }),
  sender: z.object({
    // same — отправитель в этом же банке; other — пришло из другого банка
    bank: z.enum(['same', 'other']),
    // имя, как его показывает банк: «Галина П.»; получатель сверит его с покупателем на площадке
    display_name: z.string().min(1).max(60).optional(),
    first_transfer_to_recipient: z.boolean().nullable().default(null),
    payment_purpose: z.enum(PURPOSES).nullable().default(null),
    // известно, только если отправитель в этом же банке и подключён клиентский модуль
    on_call: z.boolean().nullable().default(null),
  }),
  // отметка Антифрод-центра: банк отправителя сообщил о мошеннической операции
  antifraud_center: z
    .object({ flagged: z.boolean(), ref: z.string().max(60).optional(), reason: z.string().max(300).optional() })
    .nullable()
    .default(null),
})

type Reason = { code: 'ANTIFRAUD_CENTER' | 'TRIANGLE' | 'SENDER_ON_CALL'; text: string }

const TEXT: Record<Lang, {
  center: (ref?: string) => string
  triangle: string
  onCall: string
  hold: (name: string) => { title: string; body: string }
  notify: (name: string) => { title: string; body: string }
}> = {
  ru: {
    center: (ref) => `Банк отправителя сообщил в Антифрод-центр Национального банка о мошеннической операции${ref ? ` (${ref})` : ''}`,
    triangle: 'Отправитель указал «оплата товара или услуги», а получатель продаёт криптовалюту на P2P: так выглядит схема «треугольник»',
    onCall: 'Отправитель во время перевода разговаривал по телефону',
    hold: (name) => ({
      title: 'Поступление проверяется',
      body: `Банк отправителя сообщил, что перевод от ${name} может быть мошенническим. Деньги пока не зачислены. Не отдавайте за этот платёж криптовалюту или товар — банк свяжется с вами.`,
    }),
    notify: (name) => ({
      title: 'Сверьте отправителя, прежде чем отпускать',
      body: `Перевод от ${name} пришёл с назначением «оплата товара», а не за криптовалюту. Если это оплата вашего ордера, имя отправителя должно совпадать с покупателем на площадке. Не совпадает — не отпускайте криптовалюту: это может быть «треугольник», и деньги придётся вернуть пострадавшему.`,
    }),
  },
  kk: {
    center: (ref) => `Жіберушінің банкі Ұлттық банктің Антифрод-орталығына алаяқтық операция туралы хабарлады${ref ? ` (${ref})` : ''}`,
    triangle: 'Жіберуші «тауар немесе қызмет үшін төлем» деп көрсетті, ал алушы P2P-де криптовалюта сатады: «үшбұрыш» сызбасы осылай көрінеді',
    onCall: 'Жіберуші аударым кезінде телефонмен сөйлескен',
    hold: (name) => ({
      title: 'Түсім тексерілуде',
      body: `Жіберушінің банкі ${name} жіберген аударым алаяқтық болуы мүмкін екенін хабарлады. Ақша әзірге есептелмеді. Бұл төлем үшін криптовалюта немесе тауар бермеңіз — банк сізбен хабарласады.`,
    }),
    notify: (name) => ({
      title: 'Босатпас бұрын жіберушіні тексеріңіз',
      body: `${name} жіберген аударым криптовалюта үшін емес, «тауар үшін төлем» деп келді. Бұл сіздің ордеріңіздің төлемі болса, жіберушінің аты алаңдағы сатып алушымен сәйкес келуі керек. Сәйкес келмесе — криптовалютаны босатпаңыз: бұл «үшбұрыш» болуы мүмкін, ақшаны жәбірленушіге қайтаруға тура келеді.`,
    }),
  },
  en: {
    center: (ref) => `The sender's bank reported a fraudulent transaction to the National Bank Antifraud Center${ref ? ` (${ref})` : ''}`,
    triangle: 'The sender marked this as payment for goods or a service, while the recipient sells crypto on P2P: this is how the "triangle" scheme looks',
    onCall: 'The sender was on a phone call during the transfer',
    hold: (name) => ({
      title: 'Incoming payment is being checked',
      body: `The sender's bank reported that the transfer from ${name} may be fraudulent. The money has not been credited yet. Do not hand over crypto or goods for this payment — the bank will contact you.`,
    }),
    notify: (name) => ({
      title: 'Check the sender before releasing',
      body: `The transfer from ${name} came as "payment for goods", not for crypto. If this pays for your order, the sender's name must match the buyer on the platform. If it does not, do not release the crypto: this may be a "triangle" and the money will have to go back to the victim.`,
    }),
  },
}

export function incomingRoutes(alerts: ReturnType<typeof createAlertQueue>) {
  const router = Router()

  router.post('/incoming', (req, res) => {
    const parsed = IncomingRequest.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', message: z.prettifyError(parsed.error) })
      return
    }
    const r = parsed.data
    const t = TEXT[r.lang]
    const name = r.sender.display_name ?? (r.lang === 'en' ? 'this sender' : r.lang === 'kk' ? 'жіберуші' : 'отправителя')

    const reasons: Reason[] = []
    const flagged = r.antifraud_center?.flagged === true
    if (flagged) reasons.push({ code: 'ANTIFRAUD_CENTER', text: t.center(r.antifraud_center?.ref) })
    const triangle =
      r.recipient.p2p_trader_profile === true &&
      (r.sender.payment_purpose === 'goods' || r.sender.payment_purpose === 'services') &&
      r.sender.first_transfer_to_recipient !== false
    if (triangle) reasons.push({ code: 'TRIANGLE', text: t.triangle })
    const onCall = r.sender.on_call === true && r.recipient.p2p_trader_profile === true
    if (onCall) reasons.push({ code: 'SENDER_ON_CALL', text: t.onCall })

    // Зачисление приостанавливаем только по отметке Антифрод-центра: это сообщение банка отправителя,
    // а не наша догадка. Остальное — предупреждение получателю, деньги он получает.
    const action: IncomingAction = flagged ? 'hold_credit' : triangle || onCall ? 'notify' : 'none'

    let alertId: string | null = null
    if (action !== 'none') {
      const alert = alerts.add({
        transfer_id: r.transfer_id ?? null,
        client_ref: null,
        account_id: r.recipient.account_id,
        amount: r.amount,
        action: action === 'hold_credit' ? 'hold' : 'warn',
        risk: 0, // оценку счёта здесь не считали: решение по правилам, а не по модели
        triggers: reasons.map(({ code, text }) => ({ code, text })),
        signals: { on_call: r.sender.on_call, remote_access: null, first_transfer: r.sender.first_transfer_to_recipient, purpose: r.sender.payment_purpose },
        model_version: INCOMING_VERSION,
      })
      alertId = alert.alert_id
    }

    res.json({
      transfer_id: r.transfer_id ?? null,
      action,
      reasons,
      recipient_message: action === 'hold_credit' ? t.hold(name) : action === 'notify' ? t.notify(name) : null,
      alert_id: alertId,
    })
  })

  return router
}
