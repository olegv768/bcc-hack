import metrics from '../../ml/metrics.json'
import { KIND_LABELS, percent } from './scenarios.ts'
import { TradeoffChart } from './TradeoffChart.tsx'

const warn = metrics.account_level.find((m) => m.threshold === 'warn')!
const hold = metrics.account_level.find((m) => m.threshold === 'hold')!
const count = (value: number) => value.toLocaleString('ru-RU')

// Доли переводим в «столько-то из 100» и «из 1000»: так число сразу понятно без слова «процент».
const per = (share: number, base: number) => Math.round(share * base)

const baseline = (name: string) => metrics.baseline.account_level.find((m) => m.threshold === name)!
const stress = (model: 'model' | 'baseline') => metrics.stress[model].account_level.find((m) => m.threshold === 'warn')!

const transfers = metrics.transfer_level
const missed = (t: typeof transfers.with_call_signal) => 1 - t.fraud.hold - t.fraud.warn
const bothered = (t: typeof transfers.with_call_signal) => t.honest.hold + t.honest.warn

// Метрики из ml/metrics.json — файл пишет npm run train.
export function Metrics() {
  const fraudHeld = per(hold.droppers_found, 100)
  const fraudSeen = per(warn.droppers_found, 100)
  const honestHeld = per(hold.honest_flagged, 1000)
  const honestSeen = per(warn.honest_flagged, 1000)

  const cell = 'py-2.5 pr-4'
  const number = 'tabular py-2.5 pl-4 text-right'

  return (
    <div className="space-y-14">
      <div className="grid gap-x-16 gap-y-12 lg:grid-cols-2">
        <Outcome
          lead="Из 100 счетов мошенников сервис замечает"
          value={fraudSeen}
          total={100}
          columns={10}
          dot={16}
          gap={5}
          held={fraudHeld}
          warned={fraudSeen - fraudHeld}
          rest="пропущены"
          note={`В повторных проверках это число менялось от ${per(warn.droppers_found_interval[0]!, 100)} до ${per(warn.droppers_found_interval[1]!, 100)}.`}
        />
        <Outcome
          lead="Из 1000 честных клиентов сервис зря беспокоит"
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
        Проверка на {count(metrics.data.test_droppers)} счетах мошенников и {count(metrics.data.test_honest)} честных счетах, которых модель при
        обучении не видела. Данные синтетические: счета создаёт наш генератор, поэтому числа показывают, как модель справляется с заложенными
        нами типами счетов, а не качество на данных банка.
      </p>

      <div>
        <h3 className="text-[19px] font-semibold">Новая модель против прежней</h3>
        <p className="mt-1 mb-4 max-w-[72ch] text-[15px] text-ink-2">
          Сколько счетов мошенников из 100 замечает каждая модель. Честных клиентов обе беспокоят одинаково часто — пороги подобраны под это.
        </p>
        <table className="w-full max-w-[720px] text-left text-[15px]">
          <thead className="border-b border-ink text-[14px] text-ink-2">
            <tr>
              <th className={cell + ' font-medium'}>Условия</th>
              <th className={number + ' font-medium'}>Прежняя модель</th>
              <th className={number + ' font-medium'}>Новая модель</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['Обычные условия', baseline('warn').droppers_found, warn.droppers_found],
                ['Мошенники сменили тактику: чаще купленные и «тихие» счета', stress('baseline').droppers_found, stress('model').droppers_found],
              ] as const
            ).map(([label, before, after]) => (
              <tr key={label} className="border-b border-line">
                <td className={cell}>{label}</td>
                <td className={number}>{per(before, 100)} из 100</td>
                <td className={number + ' font-semibold'}>{per(after, 100)} из 100</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="text-[19px] font-semibold">Если сделать сервис строже или мягче</h3>
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
          <h3 className="text-[19px] font-semibold">На ком сервис срабатывает</h3>
          <p className="mt-1 mb-4 text-[15px] text-ink-2">Доля счетов каждого типа, на которых сервис среагировал.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[460px] text-left text-[15px]">
              <thead className="border-b border-ink text-[14px] text-ink-2">
                <tr>
                  <th className={cell + ' font-medium'}>Тип счёта</th>
                  <th className={number + ' font-medium'}>Счетов</th>
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
                        <td className={number + ' text-muted'}>{count(k.count)}</td>
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
          <h3 className="text-[19px] font-semibold">Что даёт сигнал звонка</h3>
          <p className="mt-1 mb-4 text-[15px] text-ink-2">Сколько мошеннических переводов из 100 проходят незамеченными.</p>
          <table className="w-full text-left text-[15px]">
            <tbody>
              <tr className="border-y border-line">
                <td className={cell}>Телефон не сообщает о звонке</td>
                <td className={number}>{per(missed(transfers.without_call_signal), 100)} из 100</td>
              </tr>
              <tr className="border-b border-line">
                <td className={cell}>Телефон сообщает о звонке</td>
                <td className={number + ' font-semibold'}>{per(missed(transfers.with_call_signal), 100)} из 100</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-4 text-[15px] text-ink-2">
            Честных клиентов при этом беспокоят почти одинаково: {per(bothered(transfers.without_call_signal), 1000)} и{' '}
            {per(bothered(transfers.with_call_signal), 1000)} из 1000.
          </p>
          <p className="mt-3 text-[14px] text-muted">
            Здесь заложено допущение, а не измерение: {per(transfers.assumptions.fraud.on_call, 100)} из 100 обманутых клиентов переводят во
            время звонка, а среди честных переводов на звонке {per(transfers.assumptions.honest.on_call, 100)} из 100. Настоящие числа банк
            узнает после подключения клиентского модуля.
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
