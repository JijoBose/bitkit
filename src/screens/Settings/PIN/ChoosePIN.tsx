import React, {
	memo,
	ReactElement,
	useState,
	useEffect,
	useCallback,
} from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import {
	View as ThemedView,
	Text01S,
	Text02S,
} from '../../../styles/components';
import NavigationHeader from '../../../components/NavigationHeader';
import NumberPad from '../../../components/NumberPad';
import useColors from '../../../hooks/colors';
import { vibrate, setKeychainValue } from '../../../utils/helpers';
import { removeTodo } from '../../../store/actions/todos';
import { updateSettings } from '../../../store/actions/settings';
import { todoPresets } from '../../../utils/todos';

const ChoosePIN = ({ navigation, route }): ReactElement => {
	const [pin, setPin] = useState<string>('');
	const [tryAgain, setTryAgain] = useState<boolean>(false);
	const origPIN = route?.params?.pin;
	const { brand, brand08 } = useColors();

	const handleOnPress = (n): void => {
		setPin((p) => {
			if (p.length === 4) {
				return;
			}
			return p + String(n);
		});
	};

	const handleOnRemove = (): void => setPin((p) => p.slice(0, -1));

	const handleOnClear = (): void => setPin('');

	// reset pin on back
	useFocusEffect(useCallback(() => setPin(''), []));

	useEffect(() => {
		const timer = setTimeout(async () => {
			if (pin.length !== 4) {
				return;
			}
			if (!origPIN) {
				navigation.push('ChoosePIN', { pin });
				return;
			}
			const pinsAreEqual = pin === origPIN;
			if (pinsAreEqual) {
				await setKeychainValue({ key: 'pin', value: pin });
				await updateSettings({ pin: true });
				removeTodo(todoPresets.pin.type);
				navigation.navigate('AskForBiometrics');
			} else {
				vibrate({ type: 'notificationWarning' });
				setPin('');
				setTryAgain(true);
			}
		}, 500);
		return (): void => clearInterval(timer);
	}, [pin, origPIN, navigation]);

	return (
		<ThemedView color="onSurface" style={styles.container}>
			<NavigationHeader
				title={origPIN ? 'Retype 4-digit PIN' : 'Choose 4-digit PIN'}
				size="sm"
				displayBackButton={origPIN ? true : false}
			/>

			{origPIN ? (
				<Text01S style={styles.text} color="gray1">
					Please retype your 4-digit PIN to complete the setup process.
				</Text01S>
			) : (
				<Text01S style={styles.text} color="gray1">
					Please use a PIN you will remember. If you forget your PIN you can
					reset it, but that will require restoring your wallet.
				</Text01S>
			)}

			<View style={styles.tryAgain}>
				{tryAgain ? (
					<Text02S color="brand">Try again, this is not the same PIN.</Text02S>
				) : (
					<Text02S> </Text02S>
				)}
			</View>

			<View style={styles.dots}>
				{Array(4)
					.fill(null)
					.map((_, i) => (
						<View
							key={i}
							style={[
								styles.dot,
								{
									borderColor: brand,
									backgroundColor: pin[i] === undefined ? brand08 : brand,
								},
							]}
						/>
					))}
			</View>

			<NumberPad
				style={styles.numberpad}
				onPress={handleOnPress}
				onRemove={handleOnRemove}
				onClear={handleOnClear}
			/>
		</ThemedView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		justifyContent: 'space-between',
	},
	text: {
		marginTop: 10,
		paddingHorizontal: 32,
	},
	tryAgain: {
		flexDirection: 'row',
		justifyContent: 'center',
		marginVertical: 16,
	},
	dots: {
		flexDirection: 'row',
		justifyContent: 'center',
		marginBottom: 32,
	},
	dot: {
		width: 20,
		height: 20,
		borderRadius: 10,
		marginHorizontal: 12,
		borderWidth: 1,
	},
	numberpad: {
		maxHeight: 350,
	},
});

export default memo(ChoosePIN);