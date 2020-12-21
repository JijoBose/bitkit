import actions from './actions';
import {
	ICreateLightningWallet,
	IUnlockLightningWallet,
} from '../types/lightning';
import { getDispatch } from '../helpers';
import lnd from 'react-native-lightning';
import LndConf from 'react-native-lightning/dist/lnd.conf';
import { ENetworks as LndNetworks } from 'react-native-lightning/dist/types';
import { getCustomLndConf } from '../../utils/lightning';

const dispatch = getDispatch();

/**
 * Starts the LND service
 * @param network
 * @returns {Promise<unknown>}
 */
export const startLnd = (network: LndNetworks) => {
	return new Promise(async (resolve) => {
		const failure = (data) => resolve({ error: true, data });

		const stateRes = await lnd.currentState();
		if (stateRes.isOk() && stateRes.value.lndRunning) {
			await dispatch({
				type: actions.UPDATE_LIGHTNING_STATE,
				payload: stateRes.value,
			});

			return resolve({ error: false, data: '' }); //Already running
		}

		const lndConf = new LndConf(network, getCustomLndConf(network));

		const res = await lnd.start(lndConf);
		if (res.isErr()) {
			return failure(res.error.message);
		}

		await refreshLightningState();
		lnd.subscribeToCurrentState((state) => {
			dispatch({
				type: actions.UPDATE_LIGHTNING_STATE,
				payload: state,
			});
		});

		resolve({ error: false, data: '' });
	});
};

/**
 * Creates a new LND wallet
 * @param password
 * @param mnemonic
 * @param network
 * @returns {Promise<unknown>}
 */
export const createLightningWallet = ({
	password,
	mnemonic,
	network,
}: ICreateLightningWallet) => {
	return new Promise(async (resolve) => {
		const failure = (data) => resolve({ error: true, data });

		const existsRes = await lnd.walletExists(network);
		if (existsRes.isOk() && existsRes.value) {
			return failure(new Error('LND wallet already exists'));
		}

		let lndSeed: string[] = [];
		if (mnemonic) {
			lndSeed = mnemonic.split(' ');
		} else {
			const seedRes = await lnd.genSeed();
			if (seedRes.isErr()) {
				return failure(
					new Error('Unable to generate mnemonic for LND wallet.'),
				);
			}

			lndSeed = seedRes.value;
		}

		const createRes = await lnd.createWallet(password, lndSeed);
		if (createRes.isErr()) {
			return failure(createRes.error);
		}
		await dispatch({
			type: actions.CREATE_LIGHTNING_WALLET,
		});

		pollLndGetInfo().then();

		resolve({ error: false, data: '' });
	});
};

/**
 * Unlocks an existing LND wallet if one exists
 * @param password
 * @param network
 * @returns {Promise<unknown>}
 */
export const unlockLightningWallet = ({
	password,
	network,
}: IUnlockLightningWallet) => {
	return new Promise(async (resolve) => {
		const failure = (data) => resolve({ error: true, data });

		const stateRes = await lnd.currentState();
		if (stateRes.isOk() && stateRes.value.grpcReady) {
			pollLndGetInfo().then();
			return resolve({ error: false, data: '' }); //Wallet already unlocked
		}

		const existsRes = await lnd.walletExists(network);
		if (existsRes.isOk() && !existsRes.value) {
			return failure(new Error('LND wallet does not exist'));
		}

		const unlockRes = await lnd.unlockWallet(password);
		if (unlockRes.isErr()) {
			return failure(unlockRes.error);
		}

		await dispatch({
			type: actions.UNLOCK_LIGHTNING_WALLET,
		});

		pollLndGetInfo().then();

		resolve({ error: false, data: '' });
	});
};

/**
 * Updates the lightning store with the latest state of LND
 * @returns {(dispatch) => Promise<unknown>}
 */
export const refreshLightningState = () => {
	return new Promise(async (resolve) => {
		const res = await lnd.currentState();
		if (res.isErr()) {
			return { error: true, data: res.error };
		}

		await dispatch({
			type: actions.UPDATE_LIGHTNING_STATE,
			payload: res.value,
		});
		resolve({ error: false, data: '' });
	});
};

/**
 * Updates the lightning store with the latest GetInfo response from LND
 * @returns {(dispatch) => Promise<unknown>}
 */
export const refreshLightningInfo = () => {
	return new Promise(async (resolve) => {
		const res = await lnd.getInfo();
		if (res.isErr()) {
			return { error: true, data: res.error };
		}

		await dispatch({
			type: actions.UPDATE_LIGHTNING_INFO,
			payload: res.value,
		});
		resolve({ error: false, data: '' });
	});
};

/**
 * Updates the lightning store with the latest WalletBalance response from LND
 * TODO: Should be removed when on chain wallet is ready to replace the built in LND wallet
 * @returns {(dispatch) => Promise<unknown>}
 */
export const refreshLightningOnChainBalance = () => {
	return new Promise(async (resolve) => {
		const res = await lnd.getWalletBalance();
		if (res.isErr()) {
			return { error: true, data: res.error };
		}

		await dispatch({
			type: actions.UPDATE_LIGHTNING_ON_CHAIN_BALANCE,
			payload: res.value,
		});
		resolve({ error: false, data: '' });
	});
};

/**
 * Updates the lightning store with the latest ChannelBalance response from LND
 * @returns {(dispatch) => Promise<unknown>}
 */
export const refreshLightningChannelBalance = () => {
	return new Promise(async (resolve) => {
		const res = await lnd.getChannelBalance();
		if (res.isErr()) {
			return { error: true, data: res.error };
		}

		await dispatch({
			type: actions.UPDATE_LIGHTNING_CHANNEL_BALANCE,
			payload: res.value,
		});
		resolve({ error: false, data: '' });
	});
};

let pollLndGetInfoTimeout;
/**
 * Keeps polling the LND service so values are kept up to date.
 * TODO: Attempt to subscribe to some of these requests instead of polling
 * @returns {Promise<void>}
 */
const pollLndGetInfo = async (): Promise<void> => {
	clearTimeout(pollLndGetInfoTimeout); //If previously subscribed make sure we don't keep have more than 1

	//If grpc hasn't even started yet rather assume lnd is not synced
	const stateRes = await lnd.currentState();
	if (stateRes.isOk() && !stateRes.value.grpcReady) {
		pollLndGetInfoTimeout = setTimeout(pollLndGetInfo, 1000);
		return;
	}

	await Promise.all([
		refreshLightningInfo(),
		refreshLightningOnChainBalance(),
		refreshLightningChannelBalance(),
	]);

	pollLndGetInfoTimeout = setTimeout(pollLndGetInfo, 3000);
};

/**
 * Pay lightning invoice and refresh channel balances after successful payment
 * @param invoice
 * @returns {Promise<{error: boolean, data: string}>}
 */
export const payLightningInvoice = (
	invoice: string,
): Promise<{ error: boolean; data: string }> => {
	return new Promise(async (resolve) => {
		const failure = (data) => resolve({ error: true, data });

		const res = await lnd.payInvoice(invoice);
		if (res.isErr()) {
			return failure(res.error);
		}

		await refreshLightningChannelBalance();

		resolve({ error: false, data: 'Paid.' });
	});
};