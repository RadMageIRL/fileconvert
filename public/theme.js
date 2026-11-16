// Applies the saved theme before the page paints, so a light-theme visitor never sees a dark flash.
try {
  var t = localStorage.getItem('fileconvert-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) { /* storage unavailable: the default theme applies */ }
