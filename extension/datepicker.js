/* datepicker.js — lightweight vanilla calendar picker */
'use strict';

class DatePicker {
  static _MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  static _DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  constructor(triggerEl, onChange, initialDate) {
    this._trigger  = triggerEl;
    this._onChange = onChange;
    this.value     = initialDate || null;
    this._popup    = null;
    this._setView(this.value || new Date().toISOString().slice(0, 10));

    triggerEl.addEventListener('click', e => {
      e.stopPropagation();
      this._popup ? this.close() : this.open();
    });
    document.addEventListener('click', () => { if (this._popup) this.close(); });
  }

  _setView(dateStr) {
    const d    = new Date(dateStr + 'T00:00:00');
    this._viewY = d.getFullYear();
    this._viewM = d.getMonth();
  }

  setValue(dateStr) {
    this.value = dateStr || null;
    this._setView(dateStr || new Date().toISOString().slice(0, 10));
  }

  open() {
    this._popup = document.createElement('div');
    this._popup.className = 'dp-popup';
    this._popup.addEventListener('click', e => e.stopPropagation());
    document.body.appendChild(this._popup);
    this._render();
    this._position();
  }

  close() {
    if (this._popup) { this._popup.remove(); this._popup = null; }
  }

  _position() {
    const r = this._trigger.getBoundingClientRect();
    const W = 228;
    let left = r.left;
    if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
    this._popup.style.top  = `${r.bottom + 4}px`;
    this._popup.style.left = `${Math.max(8, left)}px`;
  }

  _render() {
    const y = this._viewY, m = this._viewM;
    const todayStr    = new Date().toISOString().slice(0, 10);
    const firstDow    = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    const empties = Array.from({ length: firstDow }, () => '<div class="dp-cell"></div>').join('');
    let days = '';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds  = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const cls = ['dp-cell dp-day',
        ds === todayStr   ? 'dp-today' : '',
        ds === this.value ? 'dp-sel'   : '',
      ].filter(Boolean).join(' ');
      days += `<div class="${cls}" data-date="${ds}">${d}</div>`;
    }

    this._popup.innerHTML = `
      <div class="dp-hd">
        <button class="dp-nav" data-d="-1">&#8249;</button>
        <span class="dp-lbl">${DatePicker._MONTHS[m]} ${y}</span>
        <button class="dp-nav" data-d="1">&#8250;</button>
      </div>
      <div class="dp-grid">
        ${DatePicker._DAYS.map(d => `<div class="dp-wd">${d}</div>`).join('')}
        ${empties}${days}
      </div>
      ${this.value ? '<button class="dp-clr">Clear date</button>' : ''}
    `;

    this._popup.querySelectorAll('.dp-nav').forEach(btn => {
      btn.addEventListener('click', () => {
        let nm = m + parseInt(btn.dataset.d), ny = y;
        if (nm < 0)  { nm = 11; ny--; }
        if (nm > 11) { nm = 0;  ny++; }
        this._viewY = ny; this._viewM = nm;
        this._render();
      });
    });

    this._popup.querySelectorAll('.dp-day').forEach(el => {
      el.addEventListener('click', () => {
        this.value = el.dataset.date;
        this._onChange(this.value);
        this.close();
      });
    });

    this._popup.querySelector('.dp-clr')?.addEventListener('click', () => {
      this.value = null;
      this._onChange(null);
      this.close();
    });
  }
}
