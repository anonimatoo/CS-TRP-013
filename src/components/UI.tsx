import { useEffect, useId, useRef, type ComponentType, type InputHTMLAttributes, type ReactNode } from 'react';
import { LoaderCircle, X, type LucideProps } from 'lucide-react';

type Icon = ComponentType<LucideProps>;

export function SectionHeading({ icon: Icon, title, subtitle }: { icon: Icon; title: string; subtitle?: string }) {
  return <div className="section-heading">
    <span className="section-icon"><Icon size={23} aria-hidden="true" /></span>
    <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
  </div>;
}

export function Field({ label, icon: Icon, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; icon?: Icon }) {
  return <label className="field">
    <span>{label}{props.required && <span className="required" aria-hidden="true"> *</span>}</span>
    <span className={'input-shell' + (Icon ? ' has-icon' : '')}>
      {Icon && <Icon size={16} aria-hidden="true" />}
      <input {...props} />
    </span>
  </label>;
}

export function Loader() {
  return <LoaderCircle size={18} className="spinner" aria-hidden="true" />;
}

export function Modal({ children, label, onClose, wide }: { children: ReactNode; label: string; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby={id} className={wide ? 'modal modal-wide' : 'modal'}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="modal-header"><h2 id={id}>{label}</h2><button className="icon-button" type="button" onClick={onClose} aria-label="Fechar janela"><X size={21} /></button></header>
    {children}
  </dialog>;
}
