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
    IDLE_THEN_ACTIVE: (v) => `Счёт ${v} ${plural(v, 'день', 'дня', 'дней')} не использовался, а потом на него пошли деньги`,
    NEW_DEVICE: () => 'За последние 7 дней в счёт получателя входили с нового устройства',
    LINKED_SENDERS: (v) =>
      `${v} ${plural(v, 'отправитель', 'отправителя', 'отправителей')} этого счёта ${plural(v, 'переводил', 'переводили', 'переводили')} деньги и на счета, заблокированные банком`,
    CONFIRMED_FRAUD: () => 'Аналитик банка ранее подтвердил, что этот счёт используют мошенники',
    REPEAT_TARGET: (v) => `За сутки ещё ${v} ${plural(v, 'клиент получил', 'клиента получили', 'клиентов получили')} предупреждение при переводе на этот счёт`,
    REMOTE_ACCESS: () => 'На телефоне клиента включён удалённый доступ к экрану',
    ON_CALL: () => 'Клиент во время перевода разговаривает по телефону',
    FIRST_TRANSFER: () => 'Клиент раньше не переводил этому получателю',
    UNUSUAL_AMOUNT: (v) => `Сумма в ${v.toLocaleString('ru-RU')} ${plural(v, 'раз', 'раза', 'раз')} больше обычного перевода клиента`,
    TRIANGLE: () => 'Клиент платит за товар или услугу, а получатель продаёт криптовалюту на P2P-площадках: так выглядит схема «треугольник»',
  },
  kk: {
    NEW_ACCOUNT: (v) => (v < 1 ? 'Алушының шоты бүгін ашылған' : `Алушының шоты ${v} күн бұрын ашылған`),
    MANY_UNRELATED_SENDERS: (v) => `Соңғы 7 күнде шотқа бұрын аударым жасамаған ${v} адам ақша аударған`,
    FAST_OUTFLOW: (v) => `Түскен ақшаның ${Math.round(v * 100)}%-ы бір сағат ішінде шоттан шығарылады`,
    SHARED_DEVICE: (v) => `Сол құрылғылардан тағы ${v} шотқа кірген`,
    IDLE_THEN_ACTIVE: (v) => `Шот ${v} күн пайдаланылмаған, содан кейін оған ақша түсе бастады`,
    NEW_DEVICE: () => 'Соңғы 7 күнде алушының шотына жаңа құрылғыдан кірген',
    LINKED_SENDERS: (v) => `Бұл шотқа ақша жіберген ${v} адам банк бұғаттаған шоттарға да аударым жасаған`,
    CONFIRMED_FRAUD: () => 'Банк талдаушысы бұл шотты алаяқтар пайдаланатынын бұрын растаған',
    REPEAT_TARGET: (v) => `Бір тәулікте тағы ${v} клиент осы шотқа аударым кезінде ескерту алды`,
    REMOTE_ACCESS: () => 'Клиенттің телефонында экранға қашықтан қол жеткізу қосулы',
    ON_CALL: () => 'Клиент аударым кезінде телефонмен сөйлесіп тұр',
    FIRST_TRANSFER: () => 'Клиент бұл алушыға бұрын ақша аудармаған',
    UNUSUAL_AMOUNT: (v) => `Сома клиенттің әдеттегі аударымынан ${v} есе көп`,
    TRIANGLE: () => 'Клиент тауар немесе қызмет үшін төлейді, ал алушы P2P алаңдарында криптовалюта сатады: «үшбұрыш» сызбасы осылай көрінеді',
  },
  en: {
    NEW_ACCOUNT: (v) => (v < 1 ? 'Recipient account was opened today' : `Recipient account was opened ${v} days ago`),
    MANY_UNRELATED_SENDERS: (v) => `In 7 days ${v} people with no previous transfers to this recipient sent money to the account`,
    FAST_OUTFLOW: (v) => `${Math.round(v * 100)}% of incoming money leaves the account within an hour`,
    SHARED_DEVICE: (v) => `The same devices were used to sign in to ${v} other accounts`,
    IDLE_THEN_ACTIVE: (v) => `The account was unused for ${v} days, then money started coming in`,
    NEW_DEVICE: () => "In the last 7 days someone signed in to the recipient's account from a new device",
    LINKED_SENDERS: (v) => `${v} of this account's senders also sent money to accounts the bank has blocked`,
    CONFIRMED_FRAUD: () => 'A bank analyst has already confirmed this account is used by fraudsters',
    REPEAT_TARGET: (v) => `In the last 24 hours ${v} other clients were warned when sending money to this account`,
    REMOTE_ACCESS: () => "Remote access to the screen is enabled on the client's phone",
    ON_CALL: () => 'The client is on a phone call while making the transfer',
    FIRST_TRANSFER: () => 'The client has never sent money to this recipient before',
    UNUSUAL_AMOUNT: (v) => `The amount is ${v} times the client's usual transfer`,
    TRIANGLE: () => 'The client is paying for goods or a service, but the recipient sells crypto on P2P platforms: this is how the "triangle" scheme looks',
  },
}

export function reasonText(reason: Reason, lang: Lang): string {
  return REASONS[lang][reason.code](reason.value ?? 0)
}

type Message = { title: string; body: string }

// Что клиентский модуль показывает человеку. О получателе говорим осторожно: это подозрение, а не обвинение.
const MESSAGES: Record<Lang, { warnRemote: Message; warnOnCall: Message; warnTriangle: Message; warn: Message; hold: Message }> = {
  ru: {
    warnTriangle: {
      title: 'Похоже на схему «треугольник»',
      body: 'Вы платите за товар, но этот счёт обычно получает деньги за криптовалюту. Мошенники дают покупателям чужие реквизиты: деньги уйдут честному продавцу криптовалюты, а товара не будет. Сверьте имя получателя с именем продавца из объявления. Не совпадает — не платите.',
    },
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
    warnTriangle: {
      title: '«Үшбұрыш» сызбасына ұқсайды',
      body: 'Сіз тауар үшін төлеп жатырсыз, бірақ бұл шотқа әдетте криптовалюта үшін ақша түседі. Алаяқтар сатып алушыларға бөтен адамның деректемелерін береді: ақша адал криптовалюта сатушысына кетеді, ал тауар болмайды. Алушының атын хабарландырудағы сатушының атымен салыстырыңыз. Сәйкес келмесе — төлемеңіз.',
    },
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
    warnTriangle: {
      title: 'This looks like the "triangle" scheme',
      body: "You are paying for goods, but this account usually receives money for crypto. Fraudsters give buyers someone else's payment details: the money goes to an honest crypto seller and the goods never arrive. Check that the recipient's name matches the seller in the ad. If it does not, do not pay.",
    },
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

export function clientMessage(action: Action, signals: { onCall: boolean; remoteAccess: boolean; triangle?: boolean }, lang: Lang): Message | null {
  if (action === 'allow') return null
  if (action === 'hold') return MESSAGES[lang].hold
  if (signals.remoteAccess) return MESSAGES[lang].warnRemote
  if (signals.triangle) return MESSAGES[lang].warnTriangle
  return signals.onCall ? MESSAGES[lang].warnOnCall : MESSAGES[lang].warn
}
