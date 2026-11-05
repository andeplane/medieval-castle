// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { showBootError } from '../../src/ui/error';

describe('showBootError', () => {
  it('names what failed, shows the message and offers a focused reload', () => {
    document.body.innerHTML = '';
    let reloads = 0;
    const box = showBootError(document, new Error('WebGPU adapter lost'), () => { reloads++; });
    expect(box.getAttribute('role')).toBe('alert');
    expect(box.querySelector('h1')?.textContent).toBe('The castle did not load');
    expect(box.querySelector('code')?.textContent).toBe('WebGPU adapter lost');
    const b = box.querySelector('button')!;
    expect(document.activeElement).toBe(b);
    b.click();
    expect(reloads).toBe(1);
    const other = showBootError(document, 'plain string', () => {}, 'The prop kit');
    expect(other.querySelector('h1')?.textContent).toBe('The prop kit did not load');
    expect(other.querySelector('code')?.textContent).toBe('plain string');
  });
});
