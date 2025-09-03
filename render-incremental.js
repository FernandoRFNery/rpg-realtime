// Reconciliação incremental para listas/tabelas
// Uso:
//   reconcileList(container, items, getKey, render)
//   scheduleRender(fn)
// Mantém nós existentes, evita "piscar" ao atualizar.

(function (global){
  const g = global || window;

  function reconcileList(container, nextItems, getKey, render){
    if (!container) return;
    const map = new Map();
    Array.from(container.children).forEach(el => {
      const k = el.getAttribute('data-key');
      if (k) map.set(k, el);
    });

    const frag = document.createDocumentFragment();

    for (const item of (nextItems || [])){
      const key = String(getKey(item));
      let el = map.get(key);
      el = render(item, el) || el;
      if (!el) continue;
      el.setAttribute('data-key', key);
      frag.appendChild(el);
      map.delete(key); // não é órfão
    }

    // remove órfãos
    for (const [, el] of map) el.remove();

    // reordena apenas se necessário
    if (!container.firstChild || container.firstChild !== frag.firstChild) {
      container.appendChild(frag);
    }
  }

  let rafScheduled = false;
  function scheduleRender(fn){
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      try { fn && fn(); } finally { rafScheduled = false; }
    });
  }

  // exporta em escopo global
  g.reconcileList = reconcileList;
  g.scheduleRender = scheduleRender;
})(typeof window !== 'undefined' ? window : this);
