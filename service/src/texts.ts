// Тексты причин и предупреждений на трёх языках. Банк может заменить их своими формулировками.

import type { Action, Reason, ReasonCode } from './model.ts'

export type Lang = 'ru' | 'kk' | 'en'

// Русское склонение после числа: 1 счёт, 3 счёта, 5 счетов; дробное число — как «3 счёта».
function plural(n: number, one: string, few: string, many: string): string {
  if (!Number.isInteger(n)) return few
  const tens = n % 100
  const units = n % 10
  if (tens >= 11 && tens <= 14) return many
  if (units === 1) return one
  return units >= 2 && units <= 4 ? few : many
}

const REASONS: Record<Lang, Record<ReasonCode, (value: number) => string>> = {
  ru: {
    NEW_ACCOUNT: (v) => (v < 1 ? 'Счёт получателя открыт сегодня' : `Счёт получателя открыт ${v} дн. назад`),
    MANY_UNRELATED_SENDERS: (v) =>
      `За 7 дней на счёт ${plural(v, 'перевёл', 'перевели', 'перевели')} деньги ${v} ${plural(v, 'человек', 'человека', 'человек')}, с которыми у получателя раньше не было переводов`,
    FAST_OUTFLOW: (v) => `${Math.round(v * 100)}% поступлений уходит со счёта в течение часа`,
    SHARED_DEVICE: (v) => `С тех же устройств входили ещё в ${v} ${plural(v, 'счёт', 'счёта', 'счетов')}`,
    REMOTE_ACCESS: () => 'На телефоне клиента включён удалённый доступ к экрану',
    ON_CALL: () => 'Клиент во время перевода разговаривает по телефону',
    FIRST_TRANSFER: () => 'Клиент раньше не переводил этому получателю',
    UNUSUAL_AMOUNT: (v) => `Сумма в ${v.toLocaleString('ru-RU')} ${plural(v, 'раз', 'раза', 'раз')} больше обычного перевода клиента`,
  },
  kk: {
    NEW_ACCOUNT: (v) => (v < 1 ? 'Алушының шоты бүгін ашылған' : `Алушының шоты ${v} күн бұрын ашылған`),
    MANY_UNRELATED_SENDERS: (v) => `Соңғы 7 күнде шотқа бұрын аударым жасамаған ${v} адам ақша аударған`,
    FAST_OUTFLOW: (v) => `Түскен ақшаның ${Math.round(v * 100)}%-ы бір сағат ішінде шоттан шығарылады`,
    SHARED_DEVICE: (v) => `Сол құрылғылардан тағы ${v} шотқа кірген`,
    REMOTE_ACCESS: () => 'Клиенттің телефонында экранға қашықтан қол жеткізу қосулы',
    ON_CALL: () => 'Клиент аударым кезінде телефонмен сөйлесіп тұр',
    FIRST_TRANSFER: () => 'Клиент бұл алушыға бұрын ақша аудармаған',
    UNUSUAL_AMOUNT: (v) => `Сома клиенттің әдеттегі аударымынан ${v} есе көп`,
  },
  en: {
    NEW_ACCOUNT: (v) => (v < 1 ? 'Recipient account was opened today' : `Recipient account was opened ${v} days ago`),
    MANY_UNRELATED_SENDERS: (v) => `In 7 days ${v} people with no previous transfers to this recipient sent money to the account`,
    FAST_OUTFLOW: (v) => `${Math.round(v * 100)}% of incoming money leaves the account within an hour`,
    SHARED_DEVICE: (v) => `The same devices were used to sign in to ${v} other accounts`,
    REMOTE_ACCESS: () => "Remote access to the screen is enabled on the client's phone",
    ON_CALL: () => 'The client is on a phone call while making the transfer',
    FIRST_TRANSFER: () => 'The client has never sent money to this recipient before',
    UNUSUAL_AMOUNT: (v) => `The amount is ${v} times the client's usual transfer`,
  },
}

export function reasonText(reason: Reason, lang: Lang): string {
  return REASONS[lang][reason.code](reason.value ?? 0)
}

type Message = { title: string; body: string }

// Что клиентский модуль показывает человеку. О получателе говорим осторожно: это подозрение, а не обвинение.
const MESSAGES: Record<Lang, { warnRemote: Message; warnOnCall: Message; warn: Message; hold: Message }> = {
  ru: {
    warnRemote: {
      title: 'Вашим телефоном могут управлять удалённо',
      body: 'На телефоне включена программа удалённого доступа. Сотрудники банка не просят её устанавливать. Отключите её и не переводите деньги по чужой просьбе.',
    },
    warnOnCall: {
      title: 'Вы сейчас разговариваете по телефону',
      body: 'Сотрудники банка, полиции и госорганов не просят переводить деньги на «безопасный счёт». Если вас торопят с переводом — положите трубку.',
    },
    warn: {
      title: 'Проверьте, кому переводите',
      body: 'У счёта получателя есть признаки, похожие на мошенническую схему. Если вы не знаете этого человека лично — не переводите.',
    },
    hold: {
      title: 'Перевод приостановлен на проверку',
      body: 'Перевод похож на мошенническую схему. Деньги остались на вашем счёте.',
    },
  },
  kk: {
    warnRemote: {
      title: 'Телефоныңызды қашықтан басқаруы мүмкін',
      body: 'Телефонда қашықтан қол жеткізу бағдарламасы қосулы. Банк қызметкерлері оны орнатуды сұрамайды. Оны өшіріңіз және бөгде адамның өтінішімен ақша аудармаңыз.',
    },
    warnOnCall: {
      title: 'Сіз қазір телефонмен сөйлесіп тұрсыз',
      body: 'Банк, полиция және мемлекеттік орган қызметкерлері «қауіпсіз шотқа» ақша аударуды сұрамайды. Сізді асықтырса — тұтқаны қойыңыз.',
    },
    warn: {
      title: 'Кімге аударып жатқаныңызды тексеріңіз',
      body: 'Алушының шотында алаяқтық сызбасына ұқсас белгілер бар. Бұл адамды жеке танымасаңыз — ақша аудармаңыз.',
    },
    hold: {
      title: 'Аударым тексеруге тоқтатылды',
      body: 'Аударым алаяқтық сызбасына ұқсайды. Ақша сіздің шотыңызда қалды.',
    },
  },
  en: {
    warnRemote: {
      title: 'Someone may be controlling your phone remotely',
      body: "A remote access app is active on this phone. Bank staff never ask you to install one. Turn it off and do not send money at someone else's request.",
    },
    warnOnCall: {
      title: 'You are on a phone call right now',
      body: 'Bank, police and government staff never ask you to move money to a "safe account". If you are being rushed, hang up.',
    },
    warn: {
      title: 'Check who you are sending money to',
      body: 'The recipient account shows signs of a fraud scheme. If you do not know this person, do not send the money.',
    },
    hold: {
      title: 'Transfer is on hold for review',
      body: 'This transfer looks like a fraud scheme. The money is still in your account.',
    },
  },
}

export function clientMessage(action: Action, signals: { onCall: boolean; remoteAccess: boolean }, lang: Lang): Message | null {
  if (action === 'allow') return null
  if (action === 'hold') return MESSAGES[lang].hold
  if (signals.remoteAccess) return MESSAGES[lang].warnRemote
  return signals.onCall ? MESSAGES[lang].warnOnCall : MESSAGES[lang].warn
}
