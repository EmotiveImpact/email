import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  previewSegment,
  segmentsQuery,
  useDeleteSegment,
  useSaveSegment,
  vocabularyQuery,
  type Condition,
  type SegmentDefinition,
} from '../api.ts';
import { useTenant } from '../components/Shell.tsx';
import { Button, Card, Notice, Segmented, cx } from '../components/ui.tsx';
import { blankCondition, describeSegment, eventLabel, isComplete } from '../segments.ts';

const KINDS: { value: Condition['type']; label: string }[] = [
  { value: 'event', label: 'How often they…' },
  { value: 'last_event', label: 'When they last…' },
  { value: 'consent', label: 'News consent' },
  { value: 'attribute', label: 'A detail' },
  { value: 'added', label: 'When they were added' },
  { value: 'email', label: 'Their email' },
];

const control =
  'h-9 rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] text-ink outline-none focus:border-ink';

export function SegmentBuilder() {
  const tenant = useTenant();
  const { segment: segmentId } = useParams({ from: '/$tenant/audience/segments/$segment' });
  const isNew = segmentId === 'new';
  const { data: segments } = useQuery(segmentsQuery(tenant.id));
  const { data: vocab = { events: [], attributes: [] } } = useQuery(vocabularyQuery(tenant.id));
  const existing = segments?.find((s) => s.id === segmentId);
  const navigate = useNavigate();
  const save = useSaveSegment(tenant.id);
  const remove = useDeleteSegment(tenant.id);

  const [name, setName] = useState('');
  const [definition, setDefinition] = useState<SegmentDefinition>({ match: 'all', conditions: [] });
  const [loaded, setLoaded] = useState(isNew);
  useEffect(() => {
    if (!loaded && existing) {
      setName(existing.name);
      setDefinition(existing.definition);
      setLoaded(true);
    }
  }, [existing, loaded]);

  // Live count, a beat after the last change, using only finished rules.
  const ready: SegmentDefinition = { ...definition, conditions: definition.conditions.filter(isComplete) };
  const [debounced, setDebounced] = useState(ready);
  const readyKey = JSON.stringify(ready);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(JSON.parse(readyKey) as SegmentDefinition), 300);
    return () => clearTimeout(t);
  }, [readyKey]);
  const preview = useQuery({
    queryKey: ['segment-preview', tenant.id, debounced],
    queryFn: () => previewSegment(tenant.id, debounced),
    enabled: loaded,
    placeholderData: (previous) => previous,
  });

  const update = (i: number, c: Condition) => setDefinition((d) => ({ ...d, conditions: d.conditions.map((x, j) => (j === i ? c : x)) }));
  const add = () => setDefinition((d) => ({ ...d, conditions: [...d.conditions, blankCondition('event', vocab)] }));
  const drop = (i: number) => setDefinition((d) => ({ ...d, conditions: d.conditions.filter((_, j) => j !== i) }));
  const incomplete = definition.conditions.some((c) => !isComplete(c));

  async function submit() {
    const saved = await save.mutateAsync({ id: isNew ? undefined : segmentId, name, definition });
    await navigate({ to: '/$tenant/audience', params: { tenant: tenant.id }, search: { view: 'segments' } });
    return saved;
  }

  if (!isNew && segments && !existing) return <Notice tone="bad">That segment no longer exists.</Notice>;

  return (
    <>
      <Link to="/$tenant/audience" params={{ tenant: tenant.id }} search={{ view: 'segments' }} className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft size={14} /> Segments
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="flex min-w-[280px] flex-1 flex-col gap-1">
          <span className="sr-only">Segment name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this segment"
            className="display w-full border-0 border-b border-transparent bg-transparent p-0 text-[34px] leading-tight outline-none placeholder:text-faint focus:border-rule-strong"
          />
        </label>
        <div className="flex gap-2">
          {!isNew && (
            <Button
              variant="secondary"
              onClick={async () => {
                await remove.mutateAsync(segmentId);
                await navigate({ to: '/$tenant/audience', params: { tenant: tenant.id }, search: { view: 'segments' } });
              }}
            >
              <Trash2 size={14} /> Delete
            </Button>
          )}
          <Button onClick={submit} disabled={!name.trim() || incomplete || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save segment'}
          </Button>
        </div>
      </div>
      {save.isError && <Notice tone="bad">{save.error.message}</Notice>}

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_300px]">
        <Card className="flex flex-col gap-4 px-5 py-5">
          <div className="flex flex-wrap items-center gap-2.5 text-sm">
            People who match
            <Segmented
              size="sm"
              label="Match"
              value={definition.match}
              onChange={(match) => setDefinition((d) => ({ ...d, match }))}
              options={[
                { value: 'all', label: 'all' },
                { value: 'any', label: 'any' },
              ]}
            />
            of these rules
          </div>
          {definition.conditions.length === 0 && <p className="m-0 text-[13px] text-muted">No rules yet, so this is everyone. Add a rule to narrow it down.</p>}
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
            {definition.conditions.map((c, i) => (
              <li key={i} className={cx('flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5', isComplete(c) ? 'border-rule bg-soft/40' : 'border-warn bg-warn-bg/40')}>
                {i > 0 && <span className="w-full text-xs font-semibold tracking-wide text-faint uppercase">{definition.match === 'all' ? 'and' : 'or'}</span>}
                <select aria-label="Kind of rule" value={c.type} onChange={(e) => update(i, blankCondition(e.target.value as Condition['type'], vocab))} className={control}>
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <RuleFields condition={c} vocab={vocab} onChange={(next) => update(i, next)} />
                <button type="button" aria-label="Remove rule" onClick={() => drop(i)} className="ml-auto flex size-8 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted hover:bg-soft">
                  <X size={16} />
                </button>
              </li>
            ))}
          </ol>
          <Button variant="secondary" onClick={add} className="w-fit">
            <Plus size={15} /> Add a rule
          </Button>
        </Card>

        <Card className="flex flex-col gap-3 px-5 py-5 lg:sticky lg:top-0">
          <span className="text-[13px] text-muted">People in this segment now</span>
          <span className={cx('display text-[44px] leading-none transition-opacity', preview.isFetching && 'opacity-50')}>
            {preview.data ? preview.data.size.toLocaleString('en-GB') : '…'}
          </span>
          <p className="m-0 text-[13px] leading-snug text-muted">{describeSegment(ready)}.</p>
          {preview.isError && <Notice tone="bad">{preview.error.message}</Notice>}
          {preview.data && preview.data.sample.length > 0 && (
            <ul className="m-0 list-none border-t border-rule p-0 pt-2 text-[13px]">
              {preview.data.sample.map((p) => (
                <li key={p.id} className="truncate py-1">
                  {[p.firstName, p.lastName].filter(Boolean).join(' ') || p.email}
                </li>
              ))}
              {preview.data.size > preview.data.sample.length && <li className="py-1 text-muted">and {(preview.data.size - preview.data.sample.length).toLocaleString('en-GB')} more</li>}
            </ul>
          )}
          <p className="m-0 border-t border-rule pt-3 text-xs leading-relaxed text-muted">Segments update themselves. Anyone who matches the rules when you send is included.</p>
        </Card>
      </div>
    </>
  );
}

function NumberInput({ value, onChange, label, min = 1 }: { value: number | undefined; onChange: (n: number) => void; label: string; min?: number }) {
  return (
    <input
      aria-label={label}
      type="number"
      min={min}
      value={value ?? ''}
      onChange={(e) => onChange(Math.max(min, Number(e.target.value) || min))}
      className={cx(control, 'w-[72px]')}
    />
  );
}

function EventSelect({ value, events, onChange }: { value: string; events: string[]; onChange: (v: string) => void }) {
  const options = events.includes(value) ? events : [value, ...events];
  return (
    <select aria-label="Event" value={value} onChange={(e) => onChange(e.target.value)} className={control}>
      {options.map((e) => (
        <option key={e} value={e}>
          {eventLabel(e)}
        </option>
      ))}
    </select>
  );
}

function RuleFields({ condition: c, vocab, onChange }: { condition: Condition; vocab: { events: string[]; attributes: string[] }; onChange: (c: Condition) => void }) {
  const text = 'text-[13px] text-muted';
  switch (c.type) {
    case 'event':
      return (
        <>
          <EventSelect value={c.name} events={vocab.events} onChange={(name) => onChange({ ...c, name })} />
          <select aria-label="How often" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'at_least' | 'none' })} className={control}>
            <option value="at_least">at least</option>
            <option value="none">never</option>
          </select>
          {c.op === 'at_least' && (
            <>
              <NumberInput label="Times" value={c.count} onChange={(count) => onChange({ ...c, count })} />
              <span className={text}>times</span>
            </>
          )}
          <span className={text}>in the last</span>
          <NumberInput label="Days" value={c.withinDays} onChange={(withinDays) => onChange({ ...c, withinDays })} />
          <span className={text}>days</span>
        </>
      );
    case 'last_event':
      return (
        <>
          <EventSelect value={c.name} events={vocab.events} onChange={(name) => onChange({ ...c, name })} />
          <select aria-label="When" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'more_than_days_ago' | 'within_days' })} className={control}>
            <option value="more_than_days_ago">more than</option>
            <option value="within_days">within the last</option>
          </select>
          <NumberInput label="Days" value={c.days} onChange={(days) => onChange({ ...c, days })} />
          <span className={text}>{c.op === 'more_than_days_ago' ? 'days ago' : 'days'}</span>
        </>
      );
    case 'consent':
      return (
        <select aria-label="Consent" value={c.is} onChange={(e) => onChange({ ...c, is: e.target.value as 'granted' })} className={control}>
          <option value="granted">is yes</option>
          <option value="withdrawn">is no</option>
          <option value="unknown">was never asked</option>
        </select>
      );
    case 'attribute': {
      const keys = vocab.attributes.includes(c.key) ? vocab.attributes : [c.key, ...vocab.attributes];
      const needsValue = c.op !== 'exists' && c.op !== 'not_exists';
      return (
        <>
          <select aria-label="Detail" value={c.key} onChange={(e) => onChange({ ...c, key: e.target.value })} className={control}>
            {keys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select aria-label="Comparison" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as typeof c.op })} className={control}>
            <option value="equals">is</option>
            <option value="not_equals">is not</option>
            <option value="contains">contains</option>
            <option value="more_than">is more than</option>
            <option value="less_than">is less than</option>
            <option value="exists">is filled in</option>
            <option value="not_exists">is empty</option>
          </select>
          {needsValue && (
            <input
              aria-label="Value"
              value={c.value ?? ''}
              onChange={(e) => onChange({ ...c, value: c.op === 'more_than' || c.op === 'less_than' ? Number(e.target.value) : e.target.value })}
              type={c.op === 'more_than' || c.op === 'less_than' ? 'number' : 'text'}
              className={cx(control, 'w-[140px]')}
            />
          )}
        </>
      );
    }
    case 'added':
      return (
        <>
          <select aria-label="When" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'within_days' })} className={control}>
            <option value="within_days">in the last</option>
            <option value="more_than_days_ago">more than</option>
          </select>
          <NumberInput label="Days" value={c.days} onChange={(days) => onChange({ ...c, days })} />
          <span className={text}>{c.op === 'within_days' ? 'days' : 'days ago'}</span>
        </>
      );
    case 'email':
      return (
        <>
          <select aria-label="Match" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'contains' })} className={control}>
            <option value="ends_with">ends with</option>
            <option value="contains">contains</option>
          </select>
          <input aria-label="Text" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} placeholder="@company.co.uk" className={cx(control, 'w-[180px]')} />
        </>
      );
  }
}
