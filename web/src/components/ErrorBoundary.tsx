import { Component, type ReactNode } from 'react';
import { Button } from 'antd';

interface State { failed: boolean }

/** Keeps one broken view from blanking the whole app. Reset by changing `key` (e.g. the route path). */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(err: unknown) { console.error(err); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty-state">
        <h3>页面出了点问题</h3>
        <p>刷新一下通常就能恢复。</p>
        <Button onClick={() => window.location.reload()}>刷新页面</Button>
      </div>
    );
  }
}
