/** Keep existing controls within reach on a phone, without duplicated actions. */
export function setupMobileControls() {
  const query = matchMedia('(max-width: 600px)');
  const row = document.createElement('div');
  row.className = 'reader-actions';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Действия с текстом');
  const controls = ['context-button', 'sentence-button', 'fullscreen-button'].map((id) => {
    const element = document.getElementById(id);
    return { element, parent: element.parentNode, next: element.nextSibling };
  });
  document.querySelector('.transport-row').append(row);
  function arrange() {
    if (query.matches) controls.forEach(({ element }) => row.append(element));
    else controls.forEach(({ element, parent, next }) => parent.insertBefore(element, next?.parentNode === parent ? next : null));
    row.hidden = !query.matches;
  }
  query.addEventListener('change', arrange);
  arrange();
}
