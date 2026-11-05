import { useCallback, useEffect, useMemo } from 'react';
import { createRequestScope } from '../lib/request-scope';
import { useUi } from '../stores/ui';

export function useLoginTask() {
  const epoch = useUi(state => state.loginEpoch);
  const scope = useMemo(createRequestScope, []);
  useEffect(() => {
    const unsubscribe = useUi.subscribe(state => {
      if (!state.loginOpen || state.loginEpoch !== epoch) scope.cancel();
    });
    return () => { unsubscribe(); scope.cancel(); };
  }, [scope, epoch]);
  return useCallback(() => {
    const task = scope.begin();
    const isCurrent = () => task.isCurrent() && useUi.getState().loginOpen && useUi.getState().loginEpoch === epoch;
    if (!isCurrent()) scope.cancel();
    return { signal: task.signal, isCurrent };
  }, [scope, epoch]);
}
