(function (root) {
  'use strict';

  var instances = [];
  var nextId = 0;

  function asOption(item) {
    if (item && typeof item === 'object') {
      var value = item.value == null ? (item.id == null ? '' : item.id) : item.value;
      var text = item.label == null ? (item.text == null ? value : item.text) : item.label;
      return { value: String(value), label: String(text), disabled: !!item.disabled };
    }
    return { value: String(item == null ? '' : item), label: String(item == null ? '' : item), disabled: false };
  }

  function isDisabled(input) {
    var fieldset = input.closest && input.closest('fieldset');
    return !!input.disabled || !!(fieldset && fieldset.disabled);
  }

  function emit(input, type) {
    input.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function ChoicePicker(input, config) {
    this.input = input;
    this.options = (config.options || []).map(asOption);
    this.label = config.label;
    this.opened = false;
    this.active = -1;
    this.id = 'choice-picker-' + (++nextId);
    this.build();
    this.bind();
    this.syncDisabled();
  }

  ChoicePicker.prototype.build = function () {
    var input = this.input;
    var wrapper = document.createElement('div');
    wrapper.className = 'choice-picker';
    wrapper.setAttribute('data-choice-picker', '');
    var row = document.createElement('div');
    row.className = 'choice-input-row';
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'choice-toggle';
    toggle.setAttribute('aria-label', this.label ? '选择' + this.label : '打开选项');
    toggle.setAttribute('aria-haspopup', 'listbox');
    toggle.innerHTML = '<span aria-hidden="true">▾</span>';
    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'choice-clear';
    clear.setAttribute('aria-label', '清除');
    clear.textContent = '×';
    var menu = document.createElement('div');
    menu.className = 'choice-menu';
    menu.id = this.id + '-menu';
    menu.setAttribute('role', 'listbox');
    if (this.label) menu.setAttribute('aria-label', this.label);
    menu.hidden = true;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-controls', menu.id);
    toggle.setAttribute('aria-controls', menu.id);
    toggle.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-autocomplete', 'list');
    if (this.label) input.setAttribute('aria-label', this.label);
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(row);
    row.appendChild(input);
    row.appendChild(clear);
    row.appendChild(toggle);
    wrapper.appendChild(menu);
    this.wrapper = wrapper;
    this.row = row;
    this.toggle = toggle;
    this.clear = clear;
    this.menu = menu;
    this.render();
  };

  ChoicePicker.prototype.render = function () {
    var self = this;
    this.menu.textContent = '';
    this.optionNodes = [];
    this.options.forEach(function (option, index) {
      var node = document.createElement('button');
      node.type = 'button';
      node.className = 'choice-option';
      node.id = self.id + '-option-' + index;
      node.tabIndex = -1;
      node.setAttribute('role', 'option');
      node.dataset.value = option.value;
      node.textContent = option.label;
      node.disabled = option.disabled;
      node.addEventListener('click', function () { if (!node.disabled) self.choose(index); });
      self.menu.appendChild(node);
      self.optionNodes.push(node);
    });
    this.markSelected();
  };

  ChoicePicker.prototype.markSelected = function () {
    var value = this.input.value;
    this.optionNodes.forEach(function (node) {
      var selected = node.dataset.value === value;
      node.setAttribute('aria-selected', selected ? 'true' : 'false');
      node.classList.toggle('is-selected', selected);
    });
  };

  ChoicePicker.prototype.bind = function () {
    var self = this;
    this.toggle.addEventListener('click', function () { self.syncDisabled(); if (!isDisabled(self.input)) self.opened ? self.close() : self.open(); });
    this.clear.addEventListener('click', function () {
      self.syncDisabled();
      if (isDisabled(self.input)) return;
      self.input.value = '';
      self.markSelected();
      emit(self.input, 'input');
      emit(self.input, 'change');
      self.open();
      self.input.focus();
    });
    this.input.addEventListener('focus', function () { self.syncDisabled(); });
    this.input.addEventListener('input', function () { self.markSelected(); if (!isDisabled(self.input)) self.open(); });
    this.input.addEventListener('keydown', function (event) { self.keydown(event); });
  };

  ChoicePicker.prototype.syncDisabled = function () {
    var disabled = isDisabled(this.input);
    this.toggle.disabled = disabled;
    this.clear.disabled = disabled;
    this.wrapper.classList.toggle('is-disabled', disabled);
    if (disabled) this.close();
  };

  ChoicePicker.prototype.enabledIndexes = function () {
    var indexes = [];
    this.options.forEach(function (option, index) { if (!option.disabled) indexes.push(index); });
    return indexes;
  };

  ChoicePicker.prototype.open = function () {
    if (isDisabled(this.input)) return;
    instances.forEach(function (instance) { if (instance !== this) instance.close(); }, this);
    this.render();
    this.menu.hidden = false;
    this.opened = true;
    this.input.setAttribute('aria-expanded', 'true');
    this.toggle.setAttribute('aria-expanded', 'true');
  };

  ChoicePicker.prototype.close = function () {
    this.menu.hidden = true;
    this.opened = false;
    this.active = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.optionNodes.forEach(function (node) { node.classList.remove('is-active'); });
  };

  ChoicePicker.prototype.highlight = function (index) {
    var enabled = this.enabledIndexes();
    if (!enabled.length) return;
    var position = enabled.indexOf(index);
    if (position < 0) position = 0;
    this.active = enabled[position];
    this.optionNodes.forEach(function (node, i) { node.classList.toggle('is-active', i === this.active); }, this);
    var node = this.optionNodes[this.active];
    if (node) { this.input.setAttribute('aria-activedescendant', node.id); node.scrollIntoView({ block: 'nearest' }); }
  };

  ChoicePicker.prototype.move = function (delta) {
    var enabled = this.enabledIndexes();
    if (!enabled.length) return;
    var position = enabled.indexOf(this.active);
    if (position < 0) position = delta > 0 ? -1 : 0;
    position = (position + delta + enabled.length) % enabled.length;
    this.highlight(enabled[position]);
  };

  ChoicePicker.prototype.choose = function (index) {
    var option = this.options[index];
    if (!option || option.disabled || isDisabled(this.input)) return;
    this.input.value = option.value;
    this.markSelected();
    emit(this.input, 'input');
    emit(this.input, 'change');
    this.close();
    this.input.focus();
  };

  ChoicePicker.prototype.keydown = function (event) {
    this.syncDisabled();
    if (isDisabled(this.input)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!this.opened) this.open();
      this.move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && this.opened && this.active >= 0) {
      event.preventDefault();
      this.choose(this.active);
    } else if (event.key === 'Escape' && this.opened) {
      event.preventDefault();
      this.close();
    } else if (event.key === 'Tab' && this.opened) {
      this.close();
    }
  };

  function attach(input, config) {
    if (!input || input.nodeType !== 1) throw new TypeError('ChoicePickers.attach requires an input element');
    config = config || {};
    var existing = input.__choicePicker;
    if (existing) {
      existing.options = (config.options || []).map(asOption);
      existing.label = config.label;
      existing.render();
      existing.syncDisabled();
      return existing;
    }
    var instance = new ChoicePicker(input, config);
    input.__choicePicker = instance;
    instances.push(instance);
    return instance;
  }

  function closeAll() { instances.forEach(function (instance) { instance.close(); }); }

  document.addEventListener('click', function (event) {
    instances.forEach(function (instance) {
      if (!instance.wrapper.contains(event.target)) instance.close();
    });
  });

  root.ChoicePickers = { attach: attach, closeAll: closeAll };
})(typeof window !== 'undefined' ? window : globalThis);
