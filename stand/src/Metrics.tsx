import metrics from '../../ml/metrics.json'
import { KIND_LABELS, percent } from './scenarios.ts'
import { TradeoffChart } from './TradeoffChart.tsx'

const warn = metrics.account_level.find((m) => m.threshold === 'warn')!
const hold = metrics.account_level.find((m) => m.threshold === 'hold')!
const count = (value: number) => value.toLocaleString('ru-RU')

// Доли переводим в «столько-то из 100» и «из 1000»: так число сразу понятно без слова «процент».
const per = (share: number, base: number) => Math.round(share * base)

const baseline = (name: string) => metrics.baseline.account_level.find((m) => m.threshold === name)!
const ceiling = (name: string) => metrics.ceiling.account_level.find((m) => m.threshold === name)!
const stress = (model: 'model' | 'baseline' | 'ceiling') => metrics.stress[model].account_level.find((m) => m.threshold === 'warn')!

const transfers = metrics.transfer_level
const missed = (t: typeof transfers.with_call_signal) => 1 - t.fraud.hold - t.fraud.warn
const bothered = (t: typeof transfers.with_call_signal) => t.honest.hold + t.honest.warn

// Метрики из ml/metrics.json — файл пишет npm run train.
export function Metrics() {
  // Главные числа — про сервис целиком (оценка счёта плюс сведения о переводе), те же, что в первой
  // строке таблицы «Что дают сведения о самом переводе». Одна модель по счёту — в таблице сравнения ниже.
  const all = transfers.with_call_signal
  const fraudHeld = per(all.fraud.hold, 100)
  const fraudSeen = 100 - per(missed(all), 100)
  const honestHeld = per(all.honest.hold, 1000)
  const honestSeen = per(bothered(all), 1000)

  const cell = 'py-2.5 pr-4'
  const number = 'tabular py-2.5 pl-4 text-right whitespace-nowrap'

  return (
    <div className="space-y-14">
      <div className="grid gap-x-16 gap-y-12 lg:grid-cols-2">
        <Outcome
          lead="Из 100 переводов мошенникам сервис замечает"
          value={fraudSeen}
          total={100}
          columns={10}
          dot={16}
          gap={5}
          held={fraudHeld}
          warned={fraudSeen - fraudHeld}
          rest="пропущены"
          note="Учтено всё, что знает сервис: счёт получателя, звонок и был ли перевод этому получателю раньше."
        />
        <Outcome
          lead="Из 1000 честных переводов сервис зря беспокоит"
          value={honestSeen}
          total={1000}
          columns={40}
          dot={6}
          gap={2.5}
          held={honestHeld}
          warned={honestSeen - honestHeld}
          rest="переводят как обычно"
          note="Предупреждение можно прочитать и продолжить перевод."
        />
      </div>

      <p className="max-w-[72ch] text-[15px] text-ink-2">
        Проверка на {count(all.fraud.total)} мошеннических и {count(all.honest.total)} честных переводах на счета, которых модель при
        обучении не видела. Данные синтетические: счета и переводы создаёт наш генератор, поэтому числа показывают, как сервис справляется
        с заложенными нами случаями, а не качество на данных банка.
      </p>

      <div>
        <h3 className="text-[19px] font-semibold">Одна оценка счёта: новая модель против прежней</h3>
        <p className="mt-1 mb-4 max-w-[72ch] text-[15px] text-ink-2">
          Здесь сведения о переводе не учитываются — только четыре признака счёта получателя. Сколько счетов мошенников из 100 замечает каждая
          модель при одинаковой доле ложных срабатываний: {per(warn.honest_flagged, 1000)} честных счетов из 1000 на пороге «предупредить» и{' '}
          {per(hold.honest_flagged, 1000)} на пороге «придержать».
          Потолок — результат идеальной модели, которая знает, как устроены наши синтетические данные: выше него по этим четырём признакам
          подняться нельзя.
        </p>
        <table className="w-full max-w-[760px] text-left text-[15px]">
          <caption className="mb-2 text-left text-[14px] text-ink-2">Счетов мошенников из 100</caption>
          <thead className="border-b border-ink text-[14px] text-ink-2">
            <tr>
              <th className={cell + ' font-medium'}>Условия</th>
              <th className={number + ' font-medium'}>Прежняя</th>
              <th className={number + ' font-medium'}>Новая</th>
              <th className={number + ' font-medium'}>Потолок</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['Замечает (порог «предупредить»)', baseline('warn').droppers_found, warn.droppers_found, ceiling('warn').droppers_found],
                ['Придерживает перевод (порог «придержать»)', baseline('hold').droppers_found, hold.droppers_found, ceiling('hold').droppers_found],
                ['Мошенники сменили тактику: чаще купленные и «тихие» счета', stress('baseline').droppers_found, stress('model').droppers_found, stress('ceiling').droppers_found],
              ] as const
            ).map(([label, before, after, top]) => (
              <tr key={label} className="border-b border-line">
                <td className={cell}>{label}</td>
                <td className={number}>{per(before, 100)}</td>
                <td className={number + ' font-semibold'}>{per(after, 100)}</td>
                <td className={number + ' text-muted'}>{per(top, 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[14px] text-muted">
          В повторных проверках результат новой модели на пороге «предупредить» менялся от {per(warn.droppers_found_interval[0]!, 100)} до{' '}
          {per(warn.droppers_found_interval[1]!, 100)} из 100.
        </p>
      </div>

      <div>
        <h3 className="text-[19px] font-semibold">Если сделать оценку счёта строже или мягче</h3>
        <p className="mt-1 mb-4 max-w-[72ch] text-[15px] text-ink-2">
          Чем правее точка на линии, тем больше мошенников сервис замечает и тем чаще зря беспокоит честных клиентов. Банк сам выбирает, где
          остановиться; две точки — наши пороги.
        </p>
        <TradeoffChart
          points={metrics.roc}
          marks={[
            { label: 'Придержать перевод', ...hold },
            { label: 'Предупредить клиента', ...warn },
          ]}
        />
      </div>

      <div className="grid gap-x-16 gap-y-12 lg:grid-cols-[1.2fr_1fr]">
        <div className="min-w-0">
          <h3 className="text-[19px] font-semibold">На каких счетах срабатывает оценка</h3>
          <p className="mt-1 mb-4 text-[15px] text-ink-2">Доля счетов каждого типа, которые одна оценка счёта поднимает выше порогов.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[15px]">
              <thead className="border-b border-ink text-[14px] text-ink-2">
                <tr>
                  <th className={cell + ' font-medium'}>Тип счёта</th>
                  <th className={number + ' hidden font-medium sm:table-cell'}>Счетов</th>
                  <th className={number + ' font-medium'}>Среагировал</th>
                  <th className={number + ' font-medium'}>Придержал</th>
                </tr>
              </thead>
              {[true, false].map((isDropper) => (
                <tbody key={String(isDropper)}>
                  <tr>
                    <th colSpan={4} className="pt-5 pb-1.5 text-[14px] font-semibold">
                      {isDropper ? 'Мошеннические счета: чем больше, тем лучше' : 'Честные счета: чем меньше, тем лучше'}
                    </th>
                  </tr>
                  {metrics.by_kind
                    .filter((k) => k.is_dropper === isDropper)
                    .sort((a, b) => b.count - a.count)
                    .map((k) => (
                      <tr key={k.kind} className="border-b border-line">
                        <td className={cell}>{KIND_LABELS[k.kind]}</td>
                        <td className={number + ' hidden text-muted sm:table-cell'}>{count(k.count)}</td>
                        <td className={number}>{percent(k.above_warn, 0)}</td>
                        <td className={number}>{percent(k.above_hold, 0)}</td>
                      </tr>
                    ))}
                </tbody>
              ))}
            </table>
          </div>
        </div>

        <div className="min-w-0">
          <h3 className="text-[19px] font-semibold">Что дают сведения о самом переводе</h3>
          <p className="mt-1 mb-4 text-[15px] text-ink-2">
            Сервис смотрит не только на счёт получателя. Слева — сколько мошеннических переводов из 100 проходит незамеченными, справа — сколько
            честных переводов из 1000 мы беспокоим зря.
          </p>
          <table className="w-full text-left text-[15px]">
            <thead className="border-b border-ink text-[14px] text-ink-2">
              <tr>
                <th className={cell + ' font-medium'}>Что известно сервису</th>
                <th className={number + ' font-medium'}>
                  Пропущено
                  <span className="block font-normal">из 100</span>
                </th>
                <th className={number + ' font-medium'}>
                  Зря
                  <span className="block font-normal">из 1000</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Всё: звонок и был ли перевод этому получателю раньше', transfers.with_call_signal, true],
                  ['Телефон не сообщает о звонке', transfers.without_call_signal, false],
                  ['Неизвестно, переводил ли клиент этому получателю раньше', transfers.without_known_recipient_rule, false],
                ] as const
              ).map(([label, t, main]) => (
                <tr key={label} className={'border-b border-line ' + (main ? 'font-semibold' : '')}>
                  <td className={cell}>{label}</td>
                  <td className={number}>{per(missed(t), 100)}</td>
                  <td className={number}>{per(bothered(t), 1000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-[14px] text-muted">
            Здесь заложены допущения, а не измерения: {per(transfers.assumptions.fraud.on_call, 100)} из 100 обманутых клиентов переводят во
            время звонка и {per(transfers.assumptions.fraud.first_transfer, 100)} из 100 — впервые этому получателю; среди честных переводов
            на звонке {per(transfers.assumptions.honest.on_call, 100)} из 100, новому получателю —{' '}
            {per(transfers.assumptions.honest.first_transfer, 100)} из 100. Настоящие числа банк узнает на своих данных.
          </p>
        </div>
      </div>
    </div>
  )
}

const HELD = '#d32b31'
const WARNED = '#f5a300'
const REST = '#d9dee8'

// Одно утверждение «из N — столько-то» и сетка из N точек: каждая точка — один счёт или клиент.
function Outcome(props: {
  lead: string
  value: number
  total: number
  columns: number
  dot: number
  gap: number
  held: number
  warned: number
  rest: string
  note: string
}) {
  const step = props.dot + props.gap
  const rows = Math.ceil(props.total / props.columns)
  const width = props.columns * step - props.gap
  const height = rows * step - props.gap
  const left = props.total - props.held - props.warned
  const color = (i: number) => (i < props.held ? HELD : i < props.held + props.warned ? WARNED : REST)

  return (
    <figure className="m-0">
      <figcaption>
        <span className="block max-w-[26ch] text-[19px] leading-snug font-semibold">{props.lead}</span>
        <span className="tabular mt-1 block font-display text-[56px] leading-none font-semibold">{props.value}</span>
      </figcaption>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-6 block h-auto w-full"
        style={{ maxWidth: width }}
        role="img"
        aria-label={`${props.lead} ${props.value}: перевод придержан у ${props.held}, предупреждение у ${props.warned}, ${props.rest} — ${left}`}
      >
        {Array.from({ length: props.total }, (_, i) => (
          <circle
            key={i}
            cx={(i % props.columns) * step + props.dot / 2}
            cy={Math.floor(i / props.columns) * step + props.dot / 2}
            r={props.dot / 2}
            fill={color(i)}
          />
        ))}
      </svg>

      <ul className="mt-5 space-y-1.5 text-[15px]">
        <Key color={HELD} count={props.held} text="перевод придержан" />
        <Key color={WARNED} count={props.warned} text="клиент получает предупреждение" />
        <Key color={REST} count={left} text={props.rest} />
      </ul>
      <p className="mt-3 text-[14px] text-muted">{props.note}</p>
    </figure>
  )
}

function Key(props: { color: string; count: number; text: string }) {
  return (
    <li className="flex items-baseline gap-2.5">
      <span className="inline-block size-3 shrink-0 translate-y-[1px] rounded-full" style={{ background: props.color }} aria-hidden="true" />
      <b className="tabular min-w-[3ch] text-right">{props.count}</b>
      {props.text}
    </li>
  )
}
