import { DEFAULT_OPTIONS, OPTION_LIMITS } from './policy.js';
import { FusionError } from './types.js';
const LIMIT_KEYS = [
    'maxDelegations',
    'maxWorkerSteps',
    'delegationTimeoutMs',
    'maxReportCharacters',
    'sidekickMaxOutputTokens',
];
export function resolveOptions(raw) {
    const resolved = { ...DEFAULT_OPTIONS };
    if (!raw)
        return resolved;
    for (const key of LIMIT_KEYS) {
        const value = raw[key];
        if (value === undefined)
            continue;
        const limits = OPTION_LIMITS[key];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < limits.min || value > limits.max) {
            throw new FusionError('invalid_option', key);
        }
        resolved[key] = value;
    }
    if (raw.backgroundByDefault !== undefined) {
        if (typeof raw.backgroundByDefault !== 'boolean') {
            throw new FusionError('invalid_option', 'backgroundByDefault');
        }
        resolved.backgroundByDefault = raw.backgroundByDefault;
    }
    return resolved;
}
