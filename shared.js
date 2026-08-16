/* رسم هدر و فوتر مشترک در همه‌ی صفحات + آیکون گل‌تذهیب
   ---------------------------------------------------------------
   جایگزینی فونت: وقتی فایل IR Nastaliq / ایران بولد رسید، کافی است
   در shared.css بلوک @font-face با font-family:'NotoNastaliq' را با
   فایل جدید جایگزین کنید — همه‌جای سایت (این فایل هم) از همان
   نام فونت 'NotoNastaliq' استفاده می‌کند، پس چیز دیگری تغییر نمی‌خواهد.
--------------------------------------------------------------- */

const ROSETTE_SVG = `<svg class="rosette" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="3.2"/>
  <path d="M12 2 L12 8 M12 16 L12 22 M2 12 L8 12 M16 12 L22 12
           M5 5 L9 9 M15 15 L19 19 M19 5 L15 9 M9 15 L5 19"/>
  <circle cx="12" cy="12" r="9.5" stroke-dasharray="1 3.2"/>
</svg>`;

// عنوان آکادمیک انگلیسی — طبق پیشنهاد سند؛ اگر عنوان دیگری خواستید همین یک خط را عوض کنید.
const ENGLISH_TITLE = 'The Shahnameh Conceptual Atlas';

const PAGES = [
  { href: 'index.html', label: 'معرفی' },
  { href: 'atlas.html', label: 'اطلس (جست‌وجو و گراف)' },
  { href: 'research.html', label: 'پژوهش‌ها' },
  { href: 'about.html', label: 'درباره' },
  { href: 'contact.html', label: 'تماس با ما' },
];

function renderChrome(active){
  const headerEl = document.getElementById('site-header');
  const footerEl = document.getElementById('site-footer');

  if(headerEl){
    const navLinks = PAGES.map(p =>
      `<a href="${p.href}" class="${p.href === active ? 'active' : ''}">${p.label}</a>`
    ).join('');
    headerEl.innerHTML = `
      <div class="illum-border"></div>
      <div class="container site-header-inner">
        <a href="index.html" class="brand">
          <span class="brand-mark-chip"><img src="logo-mark-64.png" alt="اطلس مفهومی شاهنامه"></span>
          <span class="brand-text">اطلس مفهومی شاهنامه<small>${ENGLISH_TITLE}</small></span>
        </a>
        <nav class="main-nav">${navLinks}</nav>
      </div>
      <div class="illum-border"></div>
    `;
  }

  if(footerEl){
    footerEl.innerHTML = `
      <div class="container">
        <div class="footer-cols">
          <div class="footer-col">
            <h4>اطلس مفهومی شاهنامه</h4>
            <div>پروژه‌ای پژوهشی-متن‌باز برای نگاشت معنا، رویداد، روابط و مفاهیم شاهنامه</div>
            <div class="footer-social">
              <a href="#" class="social-badge disabled" title="به‌زودی">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M21.9 4.3 18.6 20c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9L18 7.5c.4-.4-.1-.6-.6-.2L8 13.5l-4.7-1.5c-1-.3-1-1 .2-1.5L20.6 3.4c.8-.3 1.5.2 1.3.9Z"/></svg>
                تلگرام
              </a>
              <a href="#" class="social-badge disabled" title="به‌زودی">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12c0 4.4 2.9 8.1 6.8 9.4.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.5-1.3.1-2.6 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .6 1.3.2 2.3.1 2.6.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .3.3.6.8.6 1.7v2.5c0 .3.2.6.7.5A10 10 0 0 0 22 12c0-5.5-4.5-10-10-10Z"/></svg>
                کمک مالی
              </a>
            </div>
          </div>
          <div class="footer-col">
            <h4>پیوندها</h4>
            <div><a href="atlas.html">ورود به اطلس</a></div>
            <div><a href="research.html">پژوهش‌ها</a></div>
            <div><a href="about.html">درباره‌ی پروژه</a></div>
            <div><a href="contact.html">همکاری و تماس</a></div>
          </div>
          <div class="footer-col">
            <h4>وضعیت داده</h4>
            <div id="footer-stats">در حال بارگذاری…</div>
          </div>
        </div>
        <div class="footer-note">اطلس مفهومی شاهنامه — پروژه‌ای در حال گسترش. داده‌ها هر روز کامل‌تر می‌شوند.</div>
      </div>
    `;
    if(window.ATLAS_STATS && document.getElementById('footer-stats')){
      const s = window.ATLAS_STATS;
      document.getElementById('footer-stats').textContent =
        `${s.beyts} بیت · ${s.entities} مدخل · ${s.concepts} مفهوم`;
    }
  }
}
