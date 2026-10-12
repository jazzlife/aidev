import { lazyComponent } from '@/shared/utils';

// Used by task-master: the PRD editor (CodeMirror) downloads when it is first opened.
export const PRDEditor = /* @__PURE__ */ lazyComponent(() => import('@/modules/prd-editor/PRDEditor').then((module) => module.default));
