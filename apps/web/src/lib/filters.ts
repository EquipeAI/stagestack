// Which filter options an operational table actually offers (W12).
//
// A filter menu that lists every state the schema can hold is a menu the
// organizer has to read past. The rule is not "hide the empty ones" though:
// some zeros are the answer. An empty "Blocked" is worth showing — it says
// nothing is stuck. An empty "Withdrawn" is noise. So emptiness alone does not
// decide; the filter's own definition does, via `meaningfulZero`.
//
// An active filter is never hidden, whatever its count: removing the control
// that produced the current view would strand the organizer inside it.

export type FilterOption<TId extends string = string> = {
  id: TId
  label: string
  count: number
  /** True when a zero here is itself operational news. */
  meaningfulZero?: boolean
}

export function visibleFilters<TOption extends FilterOption<string>>(
  options: ReadonlyArray<TOption>,
  active: ReadonlyArray<string> = [],
): Array<TOption> {
  return options.filter(
    (option) =>
      option.count > 0 ||
      option.meaningfulZero === true ||
      active.includes(option.id),
  )
}
