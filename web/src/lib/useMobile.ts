import { useEffect, useState } from 'react';

const Q = '(max-width: 768px)';

/** True on phone-sized screens. Layout switches between desktop (side rail + two columns) and mobile (drawer + tabs). */
export function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(Q).matches);
  useEffect(() => {
    const mq = window.matchMedia(Q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}
