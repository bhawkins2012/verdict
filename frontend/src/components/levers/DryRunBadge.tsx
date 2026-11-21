/** Marks products created by a dry run (fixtures, not real products): publishable only in development and test. */
export function DryRunBadge() {
  return <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded" title="Created by a dry run from fixtures: not a real product">Dry-run data</span>
}
