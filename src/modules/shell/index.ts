import { lazyComponent } from '@/shared/utils';

// Used by standalone-shell and task-master: the terminal (xterm) downloads when a shell is first shown.
export const Shell = /* @__PURE__ */ lazyComponent(() => import('@/modules/shell/Shell').then((module) => module.default));
