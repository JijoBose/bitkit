import React, {
	Component,
	ErrorInfo,
	PropsWithChildren,
	ReactNode,
} from 'react';
import AppError from './screens/AppError';

type ReactError = Error & ErrorInfo;
type State = {
	error: ReactError | null;
};

export default class ErrorBoundary extends Component<PropsWithChildren, State> {
	state: State = {
		error: null,
	};

	static getDerivedStateFromError(error: Error): { error: Error } {
		return { error };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
		console.error('ErrorBoundary componentDidCatch', error, errorInfo);
	}

	render(): ReactNode {
		const { error } = this.state;

		if (!error || __DEV__) {
			return this.props.children;
		}

		return <AppError error={error} />;
	}
}
