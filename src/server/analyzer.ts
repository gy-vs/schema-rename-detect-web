/**
 * 分析装配层：打平缓存 + 两版本配对 + 沿用决定 + 兼容性结论。
 * 大 schema（400+ 字段）打平结果按内容哈希缓存，配对结果按 (schemaId, from, to)
 * 只依赖 schema 内容，也缓存；审阅状态变化只会重算兼容性，不重跑匹配。
 */
import {createHash} from 'node:crypto';
import {
  CompatibilityReport,
  EffectiveDecision,
  FieldRecord,
  PairAnalysis,
  ReviewDecision,
  SchemaParseError,
} from '../core/types';
import {parseSchemaText, flattenSchema} from '../core/flatten';
import {compareFieldSets} from '../core/match';
import {buildCompatibility} from '../core/compat';
import {AdjacentStep, effectiveDecisions} from '../core/lineage';
import {SchemaDoc, Store} from './store';

export interface PairResult {
  analysis: PairAnalysis;
  review: {rev: number; decisions: ReviewDecision[]; updatedAt: string; updatedBy?: string};
  effective: EffectiveDecision[];
  compatibility: CompatibilityReport;
}

interface FlattenEntry {
  fields: FieldRecord[];
  error?: SchemaParseError;
}

export class AnalyzerService {
  private flatCache = new Map<string, FlattenEntry>();
  private pairCache = new Map<string, PairAnalysis>();

  constructor(private readonly store: Store) {}

  fieldsFor(content: string): {fields?: FieldRecord[]; error?: SchemaParseError} {
    const hash = createHash('sha1').update(content).digest('hex');
    const hit = this.flatCache.get(hash);
    if (hit) return {fields: hit.fields, error: hit.error};
    try {
      const {root} = parseSchemaText(content);
      const fields = flattenSchema(root);
      this.flatCache.set(hash, {fields});
      return {fields};
    } catch (error) {
      if (error instanceof SchemaParseError) {
        this.flatCache.set(hash, {fields: [], error});
        return {error};
      }
      throw error;
    }
  }

  analyzePair(schema: SchemaDoc, fromVersion: number, toVersion: number): PairResult {
    const from = schema.versions.find(v => v.version === fromVersion);
    const to = schema.versions.find(v => v.version === toVersion);
    if (!from || !to) throw new NotFoundError('version not found');
    if (fromVersion >= toVersion) throw new BadRequest('fromVersion 必须小于 toVersion');

    const oldParsed = this.fieldsFor(from.content);
    const newParsed = this.fieldsFor(to.content);
    if (oldParsed.error) throw new BadRequest(`旧版本（v${fromVersion}）${oldParsed.error.message}`);
    if (newParsed.error) throw new BadRequest(`新版本（v${toVersion}）${newParsed.error.message}`);

    const pairCacheKey = `${schema.id}:${contentHash(from.content)}:${contentHash(to.content)}`;
    let analysis = this.pairCache.get(pairCacheKey);
    if (!analysis) {
      analysis = compareFieldSets(oldParsed.fields!, newParsed.fields!);
      this.pairCache.set(pairCacheKey, analysis);
    }

    const review = this.store.getReview(schema.id, fromVersion, toVersion);

    // 组装相邻跳，供沿用计算
    const steps: AdjacentStep[] = [];
    for (let v = fromVersion; v < toVersion; v++) {
      const a = schema.versions.find(doc => doc.version === v);
      const b = schema.versions.find(doc => doc.version === v + 1);
      if (!a || !b) continue;
      const pa = this.fieldsFor(a.content);
      const pb = this.fieldsFor(b.content);
      if (!pa.fields || !pb.fields) continue;
      const stepKey = `${schema.id}:${contentHash(a.content)}:${contentHash(b.content)}`;
      let stepAnalysis = this.pairCache.get(stepKey);
      if (!stepAnalysis) {
        stepAnalysis = compareFieldSets(pa.fields, pb.fields);
        this.pairCache.set(stepKey, stepAnalysis);
      }
      const stepReview = this.store.getReview(schema.id, v, v + 1);
      steps.push({fromVersion: v, toVersion: v + 1, analysis: stepAnalysis, stored: stepReview.decisions});
    }

    const effective = effectiveDecisions(steps, fromVersion, toVersion, review.decisions);
    const compatibility = buildCompatibility({analysis, decisions: effective});

    return {
      analysis,
      review: {
        rev: review.rev,
        decisions: review.decisions,
        updatedAt: review.updatedAt,
        updatedBy: review.updatedBy,
      },
      effective,
      compatibility,
    };
  }
}

function contentHash(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

export class NotFoundError extends Error {}
export class BadRequest extends Error {}
