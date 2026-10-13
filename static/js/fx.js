/* Kumo effects: pointer light on glass, hero parallax, scroll reveals, nav shadow. */
(() => {
  'use strict';
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Light that follows the pointer across glass surfaces and file cards
  addEventListener('pointermove', e => {
    const el = e.target.closest && e.target.closest('.glass, .item');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    el.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });

  // Hero parallax: cloud, folder and chip sit at different depths
  const scene = document.querySelector('.scene');
  if (scene && !calm && matchMedia('(hover: hover)').matches) {
    let raf = 0;
    addEventListener('pointermove', e => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        scene.style.setProperty('--px', ((e.clientX / innerWidth - .5) * 2).toFixed(3));
        scene.style.setProperty('--py', ((e.clientY / innerHeight - .5) * 2).toFixed(3));
      });
    }, { passive: true });
  }

  // Reveal on scroll
  const targets = [...document.querySelectorAll('[data-reveal]')];
  if ('IntersectionObserver' in window && !calm) {
    const io = new IntersectionObserver(entries => entries.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }), { threshold: .18, rootMargin: '0px 0px -6% 0px' });
    targets.forEach(t => io.observe(t));
  } else targets.forEach(t => t.classList.add('in'));

  // Landing nav gains depth once you scroll
  const nav = document.querySelector('.pillnav');
  if (nav) {
    const sync = () => nav.classList.toggle('scrolled', scrollY > 20);
    sync(); addEventListener('scroll', sync, { passive: true });
  }
})();
