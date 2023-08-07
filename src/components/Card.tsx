import React, { ReactElement, ReactNode } from 'react';
import { StyleProp, StyleSheet, ViewStyle } from 'react-native';
import { TouchableOpacity } from '../styles/components';
import { IThemeColors } from '../styles/themes';

type CardProps = {
	style?: StyleProp<ViewStyle>;
	children?: ReactNode;
	color?: keyof IThemeColors;
	onPress?: () => void;
	testID?: string;
};

const Card = ({
	style,
	children,
	color = 'surface',
	testID,
	onPress,
}: CardProps): ReactElement => (
	<TouchableOpacity
		style={[styles.container, style]}
		activeOpacity={onPress ? 0.6 : 1}
		color={color}
		onPress={onPress}
		testID={testID}>
		{children}
	</TouchableOpacity>
);

const styles = StyleSheet.create({
	container: {
		width: '100%',
		alignSelf: 'center',
		borderRadius: 15,
		marginVertical: 10,
		paddingVertical: 10,
		paddingHorizontal: 20,
	},
});

export default Card;
