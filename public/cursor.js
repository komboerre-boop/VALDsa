(function() {
  if (typeof document === 'undefined') return;
  function init() {
    const cur = document.querySelector('.custom-cursor');
    if (!cur || cur._cursorInit) return;
    cur._cursorInit = true;
    document.addEventListener('mousemove', e => {
      cur.style.left = e.clientX + 'px';
      cur.style.top  = e.clientY + 'px';
    });
    function bindHover() {
      document.querySelectorAll('a,button,.btn,input,select,label,textarea').forEach(el => {
        if (el._chb) return; el._chb = 1;
        el.addEventListener('mouseenter', () => cur.classList.add('hover'));
        el.addEventListener('mouseleave', () => cur.classList.remove('hover'));
      });
    }
    bindHover();
    new MutationObserver(bindHover).observe(document.body, {childList:true,subtree:true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
