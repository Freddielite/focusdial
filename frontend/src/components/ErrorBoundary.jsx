import { Component } from "react";
import FocusMark from "./FocusMark.jsx";

// Catches render/lifecycle errors anywhere below it in the tree. Without
// this, an uncaught error in any component white-screens the whole app -
// React unmounts the tree on an error boundary-less crash, and the user
// gets a blank page with no way back short of knowing to hard-refresh.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("Uncaught render error:", error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fd-crash">
          <div className="fd-crash__mark"><FocusMark size={40} /></div>
          <div className="fd-crash__title">Something went wrong</div>
          <p className="fd-crash__body">
            The app hit an unexpected error and couldn't continue. Your data
            is safe - reload to pick back up.
          </p>
          <button className="fd-crash__btn" onClick={() => window.location.reload()}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 1 3 6.7" />
              <path d="M3 21v-6h6" />
            </svg>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
