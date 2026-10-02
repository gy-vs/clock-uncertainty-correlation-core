'use strict';

// 输入结构性错误（调用方用法不对）：直接抛异常。
// 事实之间互相矛盾不抛异常，作为 conflict 在查询结果中返回。
export class ValidationError extends TypeError {}

export function assertFiniteNumber(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ValidationError(`${name} 必须是有限数值，收到 ${String(v)}`);
  }
}

export function assertString(v, name) {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ValidationError(`${name} 必须是非空字符串`);
  }
}
