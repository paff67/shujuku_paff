<template>
  <button
    type="button"
    :disabled="disabled"
    :title="title"
    :aria-label="ariaLabel || title"
    class="acu-icon-btn"
    :class="[`acu-icon-btn--${variant}`, `acu-icon-btn--${size}`]"
    @click="$emit('click', $event)"
  >
    <i :class="icon"></i>
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  icon: string;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  variant?: 'default' | 'danger' | 'accent';
  size?: 'md' | 'sm';
}>(), {
  title: undefined,
  ariaLabel: undefined,
  disabled: false,
  variant: 'default',
  size: 'md',
});

defineEmits<{
  (e: 'click', event: MouseEvent): void;
}>();
</script>

<style scoped>
.acu-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; background: transparent;
  color: var(--acu-text-2);
  border-radius: var(--acu-radius-sm);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.acu-icon-btn--md { width: 32px; height: 32px; font-size: var(--acu-font-size-body-lg, 13px); }
.acu-icon-btn--sm { width: 22px; height: 22px; font-size: var(--acu-font-size-micro, 10px); background: var(--acu-bg-2); }

.acu-icon-btn--default:hover:not(:disabled) {
  background: linear-gradient(var(--acu-hover-overlay), var(--acu-hover-overlay)), var(--acu-bg-2);
  color: var(--acu-text-1);
}

.acu-icon-btn--danger:hover:not(:disabled) {
  color: var(--acu-danger);
  background: color-mix(in srgb, var(--acu-danger) 12%, transparent);
}

.acu-icon-btn--accent {
  background: var(--acu-bg-2);
  color: var(--acu-text-1);
}
.acu-icon-btn--accent:hover:not(:disabled) {
  background: var(--acu-accent-glow); color: var(--acu-accent);
}

.acu-icon-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--acu-accent-glow);
}

.acu-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
