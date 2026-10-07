import type {FieldChange, FieldNode, JsonValue} from './types.js';
import {typesCompatible} from './features.js';

function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 同一路径上两个节点的逐项变化，与审阅决定无关，始终展示。 */
export function compareSamePath(oldNode: FieldNode, newNode: FieldNode): FieldChange[] {
  const changes: FieldChange[] = [];
  const path = oldNode.path;

  const type = typesCompatible(oldNode.types, newNode.types);
  if (!type.ok && oldNode.types.length && newNode.types.length) {
    changes.push({
      path,
      kind: 'type',
      severity: 'error',
      message: type.detail,
      oldValue: oldNode.types.join('|'),
      newValue: newNode.types.join('|'),
    });
  } else if (type.detail.includes('放宽')) {
    changes.push({
      path,
      kind: 'type',
      severity: 'info',
      message: type.detail,
      oldValue: oldNode.types.join('|'),
      newValue: newNode.types.join('|'),
    });
  }

  if (!oldNode.required && newNode.required) {
    changes.push({
      path,
      kind: 'required',
      severity: 'error',
      message: `字段 ${path} 变为 required，旧数据里可能缺这个字段`,
      oldValue: false,
      newValue: true,
    });
  } else if (oldNode.required && !newNode.required) {
    changes.push({
      path,
      kind: 'required',
      severity: 'info',
      message: `字段 ${path} 取消 required（放宽）`,
      oldValue: true,
      newValue: false,
    });
  }

  if (
    oldNode.enumValues !== undefined ||
    newNode.enumValues !== undefined
  ) {
    if (oldNode.enumValues && newNode.enumValues) {
      const key = (v: JsonValue) => JSON.stringify(v);
      const oldSet = new Set(oldNode.enumValues.map(key));
      const newSet = new Set(newNode.enumValues.map(key));
      const dropped = [...oldSet].filter((v) => !newSet.has(v));
      const added = [...newSet].filter((v) => !oldSet.has(v));
      if (dropped.length) {
        changes.push({
          path,
          kind: 'enum',
          severity: 'error',
          message: `enum 收窄，移除了 ${dropped.length} 个取值：旧数据若取这些值将无法通过校验`,
          oldValue: oldNode.enumValues,
          newValue: newNode.enumValues,
        });
      } else if (added.length) {
        changes.push({
          path,
          kind: 'enum',
          severity: 'info',
          message: `enum 放宽，新增 ${added.length} 个取值`,
          oldValue: oldNode.enumValues,
          newValue: newNode.enumValues,
        });
      }
    } else if (oldNode.enumValues && !newNode.enumValues) {
      changes.push({
        path,
        kind: 'enum',
        severity: 'info',
        message: `字段 ${path} 移除了 enum 约束（放宽）`,
      });
    } else if (!oldNode.enumValues && newNode.enumValues) {
      changes.push({
        path,
        kind: 'enum',
        severity: 'error',
        message: `字段 ${path} 新增 enum 约束，旧数据可能不满足`,
      });
    }
  }

  if ((oldNode.format ?? '') !== (newNode.format ?? '')) {
    if (oldNode.format && newNode.format) {
      changes.push({
        path,
        kind: 'format',
        severity: 'warning',
        message: `format 变化：${oldNode.format} -> ${newNode.format}`,
        oldValue: oldNode.format,
        newValue: newNode.format,
      });
    } else if (newNode.format) {
      changes.push({
        path,
        kind: 'format',
        severity: 'warning',
        message: `字段 ${path} 新增 format ${newNode.format}，旧数据可能不满足`,
        newValue: newNode.format,
      });
    }
  }

  if (
    oldNode.constValue !== undefined ||
    newNode.constValue !== undefined
  ) {
    if (!jsonEqual(oldNode.constValue, newNode.constValue)) {
      changes.push({
        path,
        kind: 'const',
        severity: 'error',
        message: `const 变化：${JSON.stringify(oldNode.constValue)} -> ${JSON.stringify(newNode.constValue)}`,
        oldValue: oldNode.constValue,
        newValue: newNode.constValue,
      });
    }
  }

  return changes;
}
