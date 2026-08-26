document.addEventListener('DOMContentLoaded', () => {
  const burger = document.querySelector('.burger');
  const nav = document.querySelector('.nav-links');
  if (burger && nav){
    burger.addEventListener('click', () => {
      const open = nav.style.display === 'flex';
      nav.style.display = open ? 'none' : 'flex';
      nav.style.flexDirection = 'column';
      nav.style.position = 'absolute';
      nav.style.top = '76px';
      nav.style.left = '0';
      nav.style.right = '0';
      nav.style.background = 'var(--paper)';
      nav.style.padding = '20px 24px';
      nav.style.borderBottom = '1px solid var(--line)';
      nav.style.gap = '18px';
    });
  }
});

// Menu déroulant navigation (clic pour mobile/tactile, survol pour desktop via CSS)
document.querySelectorAll('.nav-dropdown-label').forEach(function(label){
  label.addEventListener('click', function(e){
    e.stopPropagation();
    const parent = label.closest('.nav-dropdown');
    document.querySelectorAll('.nav-dropdown').forEach(function(d){
      if (d !== parent) d.classList.remove('open');
    });
    parent.classList.toggle('open');
  });
});
document.addEventListener('click', function(){
  document.querySelectorAll('.nav-dropdown').forEach(function(d){ d.classList.remove('open'); });
});
