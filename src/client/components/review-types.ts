import {ReviewDecision} from '../../core/types';

/** undefined = 待确认；confirmed/rejected = 人工选择；carried = 沿用生效；reset = 沿用失效 */
export type DecisionState = ReviewDecision['decision'] | 'carried' | 'reset' | undefined;
