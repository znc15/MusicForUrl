import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, MotionConfig, domMax } from 'motion/react';
import { Toaster } from 'sonner';
import App from './App';
import { queryClient } from './lib/query-client';
import { useAuth } from './stores/auth';
import { useTheme } from './stores/theme';
import './fonts.css';
import './index.css';


function Bootstrap() {
  const refreshAll = useAuth(state => state.refreshAll);
  const applyTheme = useTheme(state => state.apply);

  React.useEffect(() => {
    applyTheme();
    void refreshAll();
  }, [applyTheme, refreshAll]);

  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* reducedMotion="user" 跟随系统设置，CSS 层另外尊重 dataset.motion。
          domMax 提供布局动画，分段控件的 layoutId 滑块依赖它。 */}
      <MotionConfig reducedMotion="user">
        <LazyMotion features={domMax} strict>
          <BrowserRouter>
            <Bootstrap />
            <Toaster position="top-center" richColors />
          </BrowserRouter>
        </LazyMotion>
      </MotionConfig>
    </QueryClientProvider>
  </React.StrictMode>,
);
