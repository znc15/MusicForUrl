import DefaultTheme from 'vitepress/theme';
import { h, watch } from 'vue';
import { useData } from 'vitepress';
import { gsap } from 'gsap';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout() {
    const { isDark } = useData();
    if (typeof window !== 'undefined') watch(isDark, () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      gsap.fromTo('.VPContent', { opacity: .7, y: 3 }, {
        opacity: 1, y: 0, duration: .32, ease: 'power2.out', overwrite: true, clearProps: 'opacity,transform',
      });
    });
    return h(DefaultTheme.Layout);
  },
};
