/**
 * 类型兼容判断。
 * integer -> number 视为放宽（兼容）；number -> integer 是收窄（不兼容）；
 * string -> integer 这类跨族变化直接不兼容。
 */
import {TypeTransitionKind} from './types';

type Relation = 'exact' | 'widened' | 'narrowed' | 'dropped' | 'incompatible';

export function typeTransition(oldTypes: string[], newTypes: string[]): TypeTransitionKind {
  const a = new Set(oldTypes);
  const b = new Set(newTypes);
  if (a.size === 0 && b.size === 0) return 'untyped';
  if (a.size === 0) return 'narrowed'; // 无类型 -> 有类型是收窄
  if (b.size === 0) return 'widened'; // 去掉 type 约束是放宽
  if (setEquals(a, b)) return 'same';

  let sawWidened = false;
  let sawNarrowed = false;

  for (const oldType of a) {
    const relation = relationToSet(oldType, b, a);
    if (relation === 'exact') continue;
    if (relation === 'widened') {
      sawWidened = true;
      continue;
    }
    if (relation === 'narrowed' || relation === 'dropped') {
      sawNarrowed = true;
      continue;
    }
    return 'changed'; // 跨族（string -> integer 这种）
  }

  if (sawWidened && !sawNarrowed) return 'widened';
  return 'narrowed';
}

/** 单个旧类型在新类型集合里的处境 */
function relationToSet(oldType: string, newSet: Set<string>, oldSet: Set<string>): Relation {
  if (newSet.has(oldType)) return 'exact';
  // integer -> number：放宽
  if ([...newSet].some(newType => widens(oldType, newType))) return 'widened';
  // number -> integer：同族收窄
  if ([...newSet].some(newType => narrowsFamily(oldType, newType))) return 'narrowed';
  // 联合里删掉一个成员（如 string|null -> string 删掉 null）：仍是收窄，不是跨族
  const sharesAnotherType = [...oldSet].some(type => type !== oldType && newSet.has(type));
  if (sharesAnotherType) return 'dropped';
  return 'incompatible';
}

function setEquals<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** 旧类型 -> 新类型是放宽 */
function widens(oldType: string, newType: string): boolean {
  return oldType === 'integer' && newType === 'number';
}

/** 旧类型 -> 新类型是同族收窄 */
function narrowsFamily(oldType: string, newType: string): boolean {
  return oldType === 'number' && newType === 'integer';
}

export function typeTransitionLabel(kind: TypeTransitionKind): string {
  switch (kind) {
    case 'same':
      return '类型一致';
    case 'widened':
      return '类型放宽（兼容，如 integer -> number）';
    case 'narrowed':
      return '类型收窄（如 number -> integer，旧数据可能放不下）';
    case 'changed':
      return '类型不兼容（如 string -> integer）';
    case 'untyped':
      return '两边都未声明类型';
  }
}

/** 同路径字段上，类型变化是否构成替换旧版本的阻断项 */
export function typeChangeIsBlocker(kind: TypeTransitionKind): boolean {
  return kind === 'changed' || kind === 'narrowed';
}
