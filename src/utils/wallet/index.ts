import { InteractionManager } from 'react-native';
import { getAddressInfo } from 'bitcoin-address-validation';
import { constants } from '@synonymdev/slashtags-sdk';
import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import { BIP32Factory } from 'bip32';
import ecc from '@bitcoinerlab/secp256k1';
import { err, ok, Result } from '@synonymdev/result';

import { EAvailableNetwork, networks } from '../networks';
import {
	getDefaultGapLimitOptions,
	getDefaultWalletShape,
	getDefaultWalletStoreShape,
} from '../../store/shapes/wallet';
import {
	IWallet,
	IWallets,
	TKeyDerivationAccountType,
	TWalletName,
} from '../../store/types/wallet';
import { IGetAddress, IGenerateAddresses } from '../types';
import i18n from '../i18n';
import { btcToSats } from '../conversion';
import { getKeychainValue, setKeychainValue } from '../keychain';
import {
	dispatch,
	getLightningStore,
	getSettingsStore,
	getStore,
	getWalletStore,
} from '../../store/helpers';
import {
	createDefaultWalletStructure,
	generateNewReceiveAddress,
	getWalletData,
	setWalletData,
	updateExchangeRates,
	updateWallet,
} from '../../store/actions/wallet';
import { TCoinSelectPreference } from '../../store/types/settings';
import { updateActivityList } from '../../store/utils/activity';
import { getBlockHeader } from './electrum';
import { invokeNodeJsMethod } from '../nodejs-mobile';
import { DefaultNodeJsMethodsShape } from '../nodejs-mobile/shapes';
import { refreshLdk } from '../lightning';
import { BITKIT_WALLET_SEED_HASH_PREFIX } from './constants';
import { moveMetaIncTxTags } from '../../store/utils/metadata';
import { refreshOrdersList } from '../../store/utils/blocktank';
import { TNode } from '../../store/types/lightning';
import { showNewOnchainTxPrompt, showNewTxPrompt } from '../../store/utils/ui';
import { promiseTimeout, reduceValue } from '../helpers';
import {
	EAddressType,
	EAvailableNetworks,
	EElectrumNetworks,
	Electrum,
	getByteCount,
	IAddress,
	ICustomGetAddress,
	IFormattedTransaction,
	IFormattedTransactions,
	IGenerateAddressesResponse,
	IGetAddressResponse,
	IKeyDerivationPath,
	IOutput,
	IRbfData,
	ISendTransaction,
	IUtxo,
	IWalletData,
	TGapLimitOptions,
	TKeyDerivationAccount,
	TKeyDerivationChange,
	TKeyDerivationCoinType,
	TKeyDerivationPurpose,
	TOnMessage,
	Transaction,
	TTransactionMessage,
	Wallet,
} from 'beignet';
import { TServer } from 'beignet/src/types/electrum';
import { showToast } from '../notifications';
import { updateUi } from '../../store/slices/ui';
import { ICustomGetScriptHash } from 'beignet/src/types/wallet';
import { ldk } from '@synonymdev/react-native-ldk';
import { resetActivityState } from '../../store/slices/activity';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

let wallet: Wallet;

export const refreshWallet = async ({
	onchain = true,
	lightning = true,
	scanAllAddresses = false, // If set to false, on-chain scanning will adhere to the gap limit (20).
	showNotification = true, // Whether to show newTxPrompt on new incoming transactions.
	selectedWallet = getSelectedWallet(),
	selectedNetwork = getSelectedNetwork(),
}: {
	onchain?: boolean;
	lightning?: boolean;
	scanAllAddresses?: boolean;
	updateAllAddressTypes?: boolean;
	showNotification?: boolean;
	selectedWallet?: TWalletName;
	selectedNetwork?: EAvailableNetwork;
} = {}): Promise<Result<string>> => {
	try {
		// wait for interactions/animations to be completed
		await new Promise((resolve) => {
			InteractionManager.runAfterInteractions(() => resolve(null));
		});

		let notificationTxid: string | undefined;

		if (onchain) {
			await refreshBeignet(scanAllAddresses);
		}

		if (lightning) {
			await refreshLdk({ selectedWallet, selectedNetwork });
			await refreshOrdersList();
		}

		if (onchain || lightning) {
			updateActivityList();
			moveMetaIncTxTags();
		}

		if (showNotification && notificationTxid) {
			showNewTxPrompt(notificationTxid);
		}

		return ok('');
	} catch (e) {
		return err(e);
	}
};

/**
 * Refreshes the on-chain wallet by calling the Beignet refreshWallet method.
 * Does not update the activity list info. Use the refreshWallet method with onchain set to true for that.
 * @async
 * @param {boolean} [scanAllAddresses] - If set to false, on-chain scanning will adhere to the saved gap limit.
 * @return {Promise<void>}
 */
const refreshBeignet = async (
	scanAllAddresses: boolean = false,
): Promise<void> => {
	const refreshWalletRes = await wallet.refreshWallet({ scanAllAddresses });
	if (refreshWalletRes.isErr()) {
		handleRefreshError(refreshWalletRes.error.message);
	} else {
		// If refresh was successful, reset the throttled state.
		if (getStore().ui.isElectrumThrottled) {
			dispatch(updateUi({ isElectrumThrottled: false }));
		}
	}
	checkGapLimit();
};

const handleRefreshError = (msg): void => {
	// If the error is due to the batch limit being exceeded, show a toast and set the throttled state.
	if (msg.includes('Batch limit exceeded')) {
		showToast({
			type: 'error',
			title: i18n.t('wallet:refresh_error_throttle_title'),
			description: i18n.t('wallet:refresh_error_throttle_description'),
		});
		dispatch(updateUi({ isElectrumThrottled: true }));
	} else {
		// If the error is not due to the batch limit, show a toast with the error message.
		showToast({
			type: 'error',
			title: i18n.t('wallet:refresh_error_title'),
			description: msg,
		});
	}
};

/**
 * In the event we temporarily changed the gap limit in Beignet when restoring Bitkit, we need to reset it back to Bitkit's default/saved values.
 */
const checkGapLimit = (): void => {
	const savedGapLimitOptions = getGapLimitOptions();
	const beignetGapLimit = wallet.gapLimitOptions;
	if (
		beignetGapLimit.lookAhead !== savedGapLimitOptions.lookAhead ||
		beignetGapLimit.lookBehind !== savedGapLimitOptions.lookBehind
	) {
		wallet.updateGapLimit(savedGapLimitOptions);
	}
};

/**
 * Generates a series of addresses based on the specified params.
 * @async
 * @param {string} selectedWallet - Wallet ID
 * @param {number} [addressAmount] - Number of addresses to generate.
 * @param {number} [changeAddressAmount] - Number of changeAddresses to generate.
 * @param {number} [addressIndex] - What index to start generating addresses at.
 * @param {number} [changeAddressIndex] - What index to start generating changeAddresses at.
 * @param {string} [keyDerivationPath] - The path to generate addresses from.
 * @param {string} [addressType] - Determines what type of address to generate (p2pkh, p2sh, p2wpkh).
 */
export const generateAddresses = async ({
	addressAmount = 10,
	changeAddressAmount = 10,
	addressIndex = 0,
	changeAddressIndex = 0,
	keyDerivationPath,
	addressType,
}: IGenerateAddresses): Promise<Result<IGenerateAddressesResponse>> => {
	try {
		return await wallet.generateAddresses({
			addressAmount,
			changeAddressAmount,
			addressIndex,
			changeAddressIndex,
			keyDerivationPath,
			addressType,
		});
	} catch (e) {
		return err(e);
	}
};

/**
 * Returns private key for the provided address data.
 * @param {IAddress} addressData
 * @param {EAvailableNetwork} [selectedNetwork]
 * @return {Promise<Result<string>>}
 */
export const getPrivateKey = async ({
	addressData,
	selectedNetwork = getSelectedNetwork(),
}: {
	addressData: IAddress;
	selectedNetwork?: EAvailableNetwork;
}): Promise<Result<string>> => {
	try {
		if (!addressData) {
			return err('No addressContent specified.');
		}

		const getPrivateKeyShapeShape = DefaultNodeJsMethodsShape.getPrivateKey();
		getPrivateKeyShapeShape.data.path = addressData.path;
		getPrivateKeyShapeShape.data.selectedNetwork = selectedNetwork;
		const getPrivateKeyResponse = await invokeNodeJsMethod(
			getPrivateKeyShapeShape,
		);
		if (getPrivateKeyResponse.error) {
			return err(getPrivateKeyResponse.value);
		}
		return ok(getPrivateKeyResponse.value);
	} catch (e) {
		return err(e);
	}
};

const slashtagsPrimaryKeyKeyChainName = (seedHash: string = ''): string =>
	'SLASHTAGS_PRIMARYKEY/' + seedHash;

export const getSlashtagsPrimaryKey = async (
	seedHash: string,
): Promise<{ error: boolean; data: string }> => {
	return getKeychainValue({ key: slashtagsPrimaryKeyKeyChainName(seedHash) });
};

export const slashtagsPrimaryKey = async (seed: Buffer): Promise<string> => {
	const network = networks.bitcoin;
	const root = bip32.fromSeed(seed, network);

	const path = constants.PRIMARY_KEY_DERIVATION_PATH;
	const keyPair = root.derivePath(path);

	return keyPair.privateKey?.toString('hex') as string;
};

const setKeychainSlashtagsPrimaryKey = async (seed: Buffer): Promise<void> => {
	const primaryKey = await slashtagsPrimaryKey(seed);
	await setKeychainValue({
		key: slashtagsPrimaryKeyKeyChainName(seedHash(seed)),
		value: primaryKey,
	});
};

export const seedHash = (seed: Buffer): string => {
	return bitcoin.crypto
		.sha256(Buffer.concat([BITKIT_WALLET_SEED_HASH_PREFIX, seed]))
		.toString('hex');
};

export const keyDerivationAccountTypes: {
	onchain: TKeyDerivationAccount;
} = {
	onchain: '0',
};

/**
 * Returns the account param of the key derivation path based on the specified account type.
 * @param {TKeyDerivationAccountType} [accountType]
 * @return {TKeyDerivationAccount}
 */
export const getKeyDerivationAccount = (
	accountType: TKeyDerivationAccountType = 'onchain',
): TKeyDerivationAccount => {
	return keyDerivationAccountTypes[accountType];
};

/**
 * Get onchain mnemonic phrase for a given wallet from storage.
 * @async
 * @param {TWalletName} [selectedWallet]
 * @return {Promise<Result<string>>}
 */
export const getMnemonicPhrase = async (
	selectedWallet: TWalletName = getSelectedWallet(),
): Promise<Result<string>> => {
	try {
		const response = await getKeychainValue({ key: selectedWallet });
		if (response.error) {
			return err(response.data);
		}
		return ok(response.data);
	} catch (e) {
		return err(e);
	}
};

/**
 * Get bip39 passphrase for a specified wallet.
 * @async
 * @param {TWalletName} selectedWallet
 * @return {Promise<string>}
 */
export const getBip39Passphrase = async (
	selectedWallet: TWalletName = getSelectedWallet(),
): Promise<string> => {
	try {
		const key = `${selectedWallet}passphrase`;
		const bip39PassphraseResult = await getKeychainValue({ key });
		if (!bip39PassphraseResult.error && bip39PassphraseResult.data) {
			return bip39PassphraseResult.data;
		}
		return '';
	} catch {
		return '';
	}
};

/**
 * Get scriptHash for a given address
 * @param {string} address
 * @param {EAvailableNetwork} [selectedNetwork]
 * @return {string}
 */
export const getScriptHash = async (
	address: string,
	selectedNetwork: EAvailableNetwork = getSelectedNetwork(),
): Promise<string> => {
	try {
		if (!address) {
			return '';
		}
		const data = DefaultNodeJsMethodsShape.getScriptHash();
		data.data.address = address;
		data.data.selectedNetwork = selectedNetwork;
		const getScriptHashResponse = await invokeNodeJsMethod<string>(data);
		if (getScriptHashResponse.error) {
			return '';
		}
		return getScriptHashResponse.value;
	} catch {
		return '';
	}
};

/**
 * Get scriptHash for a given address
 * @param {string} address
 * @param {EAvailableNetwork} [selectedNetwork]
 * @return {string}
 */
export const getCustomScriptHash = async ({
	address,
	selectedNetwork,
}: ICustomGetScriptHash): Promise<string> => {
	try {
		if (!address) {
			return '';
		}
		const data = DefaultNodeJsMethodsShape.getScriptHash();
		data.data.address = address;
		data.data.selectedNetwork = electrumNetworkToBitkitNetwork(selectedNetwork);
		const getScriptHashResponse = await invokeNodeJsMethod<string>(data);
		if (getScriptHashResponse.error) {
			return '';
		}
		return getScriptHashResponse.value;
	} catch {
		return '';
	}
};

export const electrumNetworkToBitkitNetwork = (
	network: EElectrumNetworks,
): EAvailableNetwork => {
	switch (network) {
		case EElectrumNetworks.bitcoin:
			return EAvailableNetwork.bitcoin;
		case EElectrumNetworks.bitcoinRegtest:
			return EAvailableNetwork.bitcoinRegtest;
		case EElectrumNetworks.bitcoinTestnet:
			return EAvailableNetwork.bitcoinTestnet;
	}
};

/**
 * Get address for a given keyPair, network and type.
 * @param {string} path
 * @param {EAvailableNetwork} [selectedNetwork]
 * @param {EAddressType} type - Determines what type of address to generate (p2pkh, p2sh, p2wpkh).
 * @return {string}
 */
export const getAddress = async ({
	path,
	selectedNetwork = getSelectedNetwork(),
	type,
}: IGetAddress): Promise<Result<IGetAddressResponse>> => {
	if (!path) {
		return err('No path specified');
	}
	try {
		const data = DefaultNodeJsMethodsShape.getAddress();
		data.data.path = path;
		data.data.type = type;
		data.data.selectedNetwork = selectedNetwork;
		const addressResponse = await invokeNodeJsMethod<IGetAddressResponse>(data);
		return ok(addressResponse.value);
	} catch (e) {
		return err(e);
	}
};

/**
 * Get address for a given keyPair, network and type.
 * @param {string} path
 * @param {EAvailableNetwork} [selectedNetwork]
 * @param {EAddressType} type - Determines what type of address to generate (p2pkh, p2sh, p2wpkh).
 * @return {string}
 */
export const customGetAddress = async ({
	path,
	selectedNetwork,
	type,
}: ICustomGetAddress): Promise<Result<IGetAddressResponse>> => {
	if (!path) {
		return err('No path specified');
	}
	try {
		const data = DefaultNodeJsMethodsShape.getAddress();
		data.data.path = path;
		data.data.type = type;
		data.data.selectedNetwork = electrumNetworkToBitkitNetwork(selectedNetwork);
		const addressResponse = await invokeNodeJsMethod<IGetAddressResponse>(data);
		return ok(addressResponse.value);
	} catch (e) {
		return err(e);
	}
};

/**
 * Determine if a given mnemonic is valid.
 * @param {string} mnemonic - The mnemonic to validate.
 * @return {boolean}
 */
export const validateMnemonic = (mnemonic: string): boolean => {
	try {
		return bip39.validateMnemonic(mnemonic);
	} catch (error) {
		console.error('error validating mnemonic', error);
		return false;
	}
};

/**
 * Get the current Bitcoin balance in sats. (Confirmed+Unconfirmed)
 * @param {string} selectedWallet
 * @param {string} selectedNetwork
 * @return number - Will always return balance in sats.
 */
export const getOnChainBalance = ({
	selectedWallet = getSelectedWallet(),
	selectedNetwork = getSelectedNetwork(),
}: {
	selectedWallet?: TWalletName;
	selectedNetwork?: EAvailableNetwork;
} = {}): number => {
	return getWalletStore().wallets[selectedWallet]?.balance[selectedNetwork];
};

/**
 * Returns the currently selected network.
 * @return {EAvailableNetwork}
 */
export const getSelectedNetwork = (): EAvailableNetwork => {
	return getWalletStore()?.selectedNetwork ?? 'bitcoin';
};

/**
 * Returns the currently selected address type (p2pkh | p2sh | p2wpkh | p2tr).
 * @returns {EAddressType}
 */
export const getSelectedAddressType = ({
	selectedWallet = getSelectedWallet(),
	selectedNetwork = getSelectedNetwork(),
}: {
	selectedWallet?: TWalletName;
	selectedNetwork?: EAvailableNetwork;
} = {}): EAddressType => {
	const storedWallet = getWalletStore().wallets[selectedWallet];
	if (storedWallet?.addressType[selectedNetwork]) {
		return storedWallet.addressType[selectedNetwork];
	} else {
		return getDefaultWalletShape().addressType[selectedNetwork];
	}
};

/**
 * Returns the currently monitored address types (p2pkh | p2sh | p2wpkh | p2tr).
 * @returns {EAddressType[]}
 */
export const getAddressTypesToMonitor = (): EAddressType[] => {
	return getWalletStore().addressTypesToMonitor;
};

/**
 * Returns the currently monitored address types (p2pkh | p2sh | p2wpkh | p2tr).
 * @returns {EAddressType[]}
 */
export const getGapLimitOptions = (): TGapLimitOptions => {
	return getWalletStore().gapLimitOptions;
};

/**
 * Returns the currently selected wallet (Ex: 'wallet0').
 * @return {TWalletName}
 */
export const getSelectedWallet = (): TWalletName => {
	return getWalletStore()?.selectedWallet ?? 'wallet0';
};

/**
 * Returns all state data for the currently selected wallet.
 * @param {EAvailableNetwork} [selectedNetwork]
 * @param {TWalletName} [selectedWallet]
 * @return {{ currentWallet: IWallet, currentLightningNode: TNode, selectedWallet: TWalletName, selectedNetwork: EAvailableNetwork }}
 */
export const getCurrentWallet = ({
	selectedNetwork = getSelectedNetwork(),
	selectedWallet = getSelectedWallet(),
}: {
	selectedNetwork?: EAvailableNetwork;
	selectedWallet?: TWalletName;
} = {}): {
	currentWallet: IWallet;
	currentLightningNode: TNode;
	selectedNetwork: EAvailableNetwork;
	selectedWallet: TWalletName;
} => {
	const walletStore = getWalletStore();
	const lightning = getLightningStore();
	const currentLightningNode = lightning.nodes[selectedWallet];
	const currentWallet = walletStore.wallets[selectedWallet];
	return {
		currentWallet,
		currentLightningNode,
		selectedNetwork,
		selectedWallet,
	};
};

export const getOnChainTransactions = ({
	selectedWallet = getSelectedWallet(),
	selectedNetwork = getSelectedNetwork(),
}: {
	selectedWallet: TWalletName;
	selectedNetwork: EAvailableNetwork;
}): IFormattedTransactions => {
	return (
		getWalletStore().wallets[selectedWallet]?.transactions[selectedNetwork] ??
		{}
	);
};

/**
 * @param {string} txid
 * @param {TWalletName} [selectedWallet]
 * @param {EAvailableNetwork} [selectedNetwork]
 * @return {Result<IFormattedTransaction>}
 */
export const getTransactionById = ({
	txid,
	selectedWallet = getSelectedWallet(),
	selectedNetwork = getSelectedNetwork(),
}: {
	txid: string;
	selectedWallet?: TWalletName;
	selectedNetwork?: EAvailableNetwork;
}): Result<IFormattedTransaction> => {
	const transactions = getOnChainTransactions({
		selectedNetwork,
		selectedWallet,
	});
	if (txid in transactions) {
		return ok(transactions[txid]);
	} else {
		return err('Unable to locate the specified txid.');
	}
};

export interface ITransaction<T> {
	id: number;
	jsonrpc: string;
	param: string;
	data: T;
	result: {
		blockhash: string;
		confirmations: number;
		hash: string;
		hex: string;
		locktime: number;
		size: number;
		txid: string;
		version: number;
		vin: IVin[];
		vout: IVout[];
		vsize: number;
		weight: number;
		blocktime?: number;
		time?: number;
	};
}

export interface ITxHash {
	tx_hash: string;
}

export const getCustomElectrumPeers = ({
	selectedNetwork = getSelectedNetwork(),
}: {
	selectedNetwork?: EAvailableNetwork;
}): TServer[] => {
	return getSettingsStore().customElectrumPeers[selectedNetwork];
};

export interface IVin {
	scriptSig: {
		asm: string;
		hex: string;
	};
	sequence: number;
	txid: string;
	txinwitness: string[];
	vout: number;
}

export interface IVout {
	n: number; //0
	scriptPubKey: {
		addresses?: string[];
		address?: string;
		asm: string;
		hex: string;
		reqSigs?: number;
		type?: string;
	};
	value: number;
}

/**
 * Using a tx_hash this method will return the necessary data to create a
 * replace-by-fee transaction for any 0-conf, RBF-enabled tx.
 * @param txHash
 */
export const getRbfData = async ({
	txHash,
}: {
	txHash: ITxHash;
}): Promise<Result<IRbfData>> => {
	return await wallet.getRbfData({ txHash });
};

/**
 * Converts IRbfData to ISendTransaction.
 * CURRENTLY NOT USED
 * @param {IRbfData} data
 */
// export const formatRbfData = async (
// 	data: IRbfData,
// ): Promise<Partial<ISendTransaction>> => {
// 	const { selectedWallet, inputs, outputs, fee, selectedNetwork, message } =
// 		data;

// 	let changeAddress: undefined | string;
// 	let satsPerByte = 1;
// 	let selectedFeeId = EFeeId.none;
// 	let transactionSize = TRANSACTION_DEFAULTS.baseTransactionSize; //In bytes (250 is about normal)
// 	let label = ''; // User set label for a given transaction.

// 	const { currentWallet } = getCurrentWallet({
// 		selectedWallet,
// 		selectedNetwork,
// 	});
// 	const changeAddressesObj = currentWallet.changeAddresses[selectedNetwork];
// 	const changeAddresses = Object.values(changeAddressesObj).map(
// 		({ address }) => address.address,
// 	);

// 	let newOutputs = outputs;
// 	outputs.map(({ address }, index) => {
// 		if (address && changeAddresses.includes(address)) {
// 			changeAddress = address;
// 			newOutputs.splice(index, 1);
// 		}
// 	});

// 	let newFee = 0;
// 	let newSatsPerByte = satsPerByte;
// 	while (fee > newFee) {
// 		newFee = getTotalFee({
// 			selectedWallet,
// 			satsPerByte: newSatsPerByte,
// 			selectedNetwork,
// 			message,
// 		});
// 		newSatsPerByte = newSatsPerByte + 1;
// 	}

// 	const newFiatAmount = getTransactionOutputValue({ outputs });

// 	return {
// 		changeAddress: changeAddress || '',
// 		message,
// 		label,
// 		outputs: newOutputs,
// 		inputs,
// 		fee: newFee,
// 		satsPerByte: newSatsPerByte,
// 		fiatAmount: newFiatAmount,
// 		selectedFeeId,
// 		transactionSize,
// 	};
// };

/**
 * Generates a newly specified wallet.
 * @param {string} [wallet]
 * @param {string} [mnemonic]
 * @param {string} [bip39Passphrase]
 * @param {EAddressType} [addressTypesToCreate]
 * @return {Promise<Result<IWallets>>}
 */
export const createDefaultWallet = async ({
	walletName,
	mnemonic,
	bip39Passphrase,
	restore,
	addressTypesToCreate = getDefaultWalletStoreShape().addressTypesToMonitor,
	selectedNetwork = getSelectedNetwork(),
	servers,
}: {
	walletName: TWalletName;
	mnemonic: string;
	bip39Passphrase: string;
	restore: boolean;
	addressTypesToCreate?: EAddressType[];
	selectedNetwork?: EAvailableNetwork;
	servers?: TServer | TServer[];
}): Promise<Result<IWallets>> => {
	try {
		const selectedAddressType = getSelectedAddressType();

		if (!bip39Passphrase) {
			bip39Passphrase = await getBip39Passphrase(walletName);
		}

		const wallets = getWalletStore().wallets;
		if (walletName in wallets && wallets[walletName]?.id) {
			return err(`Wallet "${walletName}" already exists.`);
		}
		if (!validateMnemonic(mnemonic)) {
			if (restore) {
				return err(i18n.t('wallet:create_wallet_mnemonic_restore_error'));
			} else {
				return err(i18n.t('wallet:create_wallet_mnemonic_error'));
			}
		}
		await setKeychainValue({ key: walletName, value: mnemonic });
		await setKeychainValue({
			key: `${walletName}passphrase`,
			value: bip39Passphrase,
		});

		const seed = await bip39.mnemonicToSeed(mnemonic, bip39Passphrase);
		await setKeychainSlashtagsPrimaryKey(seed);

		await createDefaultWalletStructure({ walletName });

		let gapLimitOptions = getDefaultGapLimitOptions();
		if (restore) {
			// Temporarily increase the gap limit to ensure all addresses are scanned.
			gapLimitOptions = {
				lookAhead: 20,
				lookBehind: 20,
			};
		}

		const defaultWalletShape = getDefaultWalletShape();
		const setupWalletRes = await setupOnChainWallet({
			name: walletName,
			selectedNetwork,
			bip39Passphrase: bip39Passphrase,
			addressType: selectedAddressType,
			servers,
			disableMessagesOnCreate: true,
			addressTypesToMonitor: addressTypesToCreate,
			gapLimitOptions,
		});
		if (setupWalletRes.isErr()) {
			return err(setupWalletRes.error.message);
		}
		const walletData = setupWalletRes.value.data;

		const payload: IWallets = {
			[walletName]: {
				...defaultWalletShape,
				seedHash: seedHash(seed),
				addressType: {
					bitcoin: selectedAddressType,
					bitcoinTestnet: selectedAddressType,
					bitcoinRegtest: selectedAddressType,
				},
				addressIndex: {
					...defaultWalletShape.addressIndex,
					[selectedNetwork]: {
						...defaultWalletShape.addressIndex[selectedNetwork],
						...walletData.addressIndex,
					},
				},
				changeAddressIndex: {
					...defaultWalletShape.changeAddressIndex,
					[selectedNetwork]: {
						...defaultWalletShape.changeAddressIndex[selectedNetwork],
						...walletData.changeAddressIndex,
					},
				},
				addresses: {
					...defaultWalletShape.addresses,
					[selectedNetwork]: {
						...defaultWalletShape.addresses[selectedNetwork],
						...walletData.addresses,
					},
				},
				changeAddresses: {
					...defaultWalletShape.changeAddresses,
					[selectedNetwork]: {
						...defaultWalletShape.changeAddresses[selectedNetwork],
						...walletData.changeAddresses,
					},
				},
				lastUsedAddressIndex: {
					...defaultWalletShape.lastUsedAddressIndex,
					[selectedNetwork]: {
						...defaultWalletShape.lastUsedAddressIndex[selectedNetwork],
						...walletData.lastUsedAddressIndex,
					},
				},
				lastUsedChangeAddressIndex: {
					...defaultWalletShape.lastUsedChangeAddressIndex,
					[selectedNetwork]: {
						...defaultWalletShape.lastUsedChangeAddressIndex[selectedNetwork],
						...walletData.lastUsedChangeAddressIndex,
					},
				},
				transaction: {
					...defaultWalletShape.transaction,
					[selectedNetwork]: walletData.transaction,
				},
				transactions: {
					...defaultWalletShape.transactions,
					[selectedNetwork]: walletData.transactions,
				},
				unconfirmedTransactions: {
					...defaultWalletShape.unconfirmedTransactions,
					[selectedNetwork]: walletData.unconfirmedTransactions,
				},
				utxos: {
					...defaultWalletShape.utxos,
					[selectedNetwork]: walletData.utxos,
				},
				id: walletData.id,
			},
		};
		return ok(payload);
	} catch (e) {
		return err(e);
	}
};

const onElectrumConnectionChange = (isConnected: boolean): void => {
	// get state fresh from store everytime
	const { isConnectedToElectrum } = getStore().ui;

	if (!isConnectedToElectrum && isConnected) {
		dispatch(updateUi({ isConnectedToElectrum: isConnected }));
		showToast({
			type: 'success',
			title: i18n.t('other:connection_restored_title'),
			description: i18n.t('other:connection_restored_message'),
		});
	}

	if (isConnectedToElectrum && !isConnected) {
		dispatch(updateUi({ isConnectedToElectrum: isConnected }));
		showToast({
			type: 'error',
			title: i18n.t('other:connection_reconnect_title'),
			description: i18n.t('other:connection_reconnect_msg'),
		});
	}
};

const onMessage: TOnMessage = (key, data) => {
	switch (key) {
		case 'transactionReceived':
			if (
				wallet?.isSwitchingNetworks !== undefined &&
				!wallet?.isSwitchingNetworks
			) {
				const txMsg: TTransactionMessage = data as TTransactionMessage;
				const txId = txMsg.transaction.txid;
				const { currentWallet, selectedNetwork } = getCurrentWallet();

				const transfer = currentWallet.transfers[selectedNetwork].find((t) => {
					return t.txId === txId;
				});
				const isTransferToSavings = transfer?.type === 'coop-close' ?? false;

				if (!isTransferToSavings) {
					showNewOnchainTxPrompt({
						id: txId,
						value: btcToSats(txMsg.transaction.value),
					});
				}
			}
			setTimeout(() => {
				updateActivityList();
			}, 500);
			break;
		case 'transactionSent':
			setTimeout(() => {
				updateActivityList();
			}, 500);
			break;
		case 'connectedToElectrum':
			onElectrumConnectionChange(data as boolean);
			break;
		case 'reorg':
			const utxoArr = data as IUtxo[];
			// Notify user that a reorg has occurred and that the transaction has been pushed back into the mempool.
			showToast({
				type: 'info',
				title: i18n.t('wallet:reorg_detected'),
				description: i18n.t('wallet:reorg_msg_begin', {
					count: utxoArr.length,
				}),
				autoHide: false,
			});
			break;
		case 'rbf':
			const rbfData = data as string[];
			showToast({
				type: 'error',
				title: i18n.t('wallet:activity_removed_title'),
				description: i18n.t('wallet:activity_removed_msg', {
					count: rbfData.length,
				}),
				autoHide: false,
			});
			break;
		case 'newBlock':
			refreshWallet({}).then();
	}
};

export const setupOnChainWallet = async ({
	name = getSelectedWallet(),
	mnemonic,
	bip39Passphrase,
	selectedNetwork = getSelectedNetwork(),
	addressType = getSelectedAddressType(),
	setStorage = true,
	servers,
	disableMessagesOnCreate = false,
	addressTypesToMonitor = [addressType],
	gapLimitOptions = getDefaultGapLimitOptions(),
}: {
	name: TWalletName;
	mnemonic?: string;
	bip39Passphrase?: string;
	selectedNetwork?: EAvailableNetwork;
	addressType?: EAddressType;
	setStorage?: boolean;
	servers?: TServer | TServer[];
	disableMessagesOnCreate?: boolean;
	addressTypesToMonitor?: EAddressType[];
	gapLimitOptions?: TGapLimitOptions;
}): Promise<Result<Wallet>> => {
	if (!mnemonic) {
		const mnemonicRes = await getMnemonicPhrase(name);
		if (mnemonicRes.isErr()) {
			return err(mnemonicRes.error.message);
		}
		mnemonic = mnemonicRes.value;
	}
	// Fetch any stored custom peers.
	const customPeers = servers ?? getCustomElectrumPeers({ selectedNetwork });
	let storage;
	if (setStorage) {
		storage = {
			getData: getWalletData,
			setData: setWalletData,
		};
	}
	updateExchangeRates();
	const createWalletResponse = await Wallet.create({
		name,
		mnemonic,
		onMessage,
		passphrase: bip39Passphrase,
		network: EAvailableNetworks[selectedNetwork],
		electrumOptions: {
			servers: customPeers,
			tls: global.tls,
			net: global.net,
		},
		gapLimitOptions,
		storage,
		addressType,
		customGetAddress: customGetAddress,
		customGetScriptHash: getCustomScriptHash,
		disableMessagesOnCreate,
		addressTypesToMonitor,
	});
	if (createWalletResponse.isErr()) {
		return err(createWalletResponse.error.message);
	}
	wallet = createWalletResponse.value;
	return ok(wallet);
};

/**
 * large = Sort by and use largest UTXO first. Lowest fee, but reveals your largest UTXO's and reduces privacy.
 * small = Sort by and use smallest UTXO first. Higher fee, but hides your largest UTXO's and increases privacy.
 * consolidate = Use all available UTXO's regardless of the amount being sent. Preferable to use this method when fees are low in order to reduce fees in future transactions.
 */
export interface IAddressIOTypes {
	inputs: {
		[key in EAddressType]: number;
	};
	outputs: {
		[key in EAddressType]: number;
	};
}
/**
 * Returns the transaction fee and outputs along with the inputs that best fit the sort method.
 * @async
 * @param {IAddress[]} inputs
 * @param {IAddress[]} outputs
 * @param {number} [satsPerByte]
 * @param {sortMethod}
 * @return {Promise<number>}
 */
export interface ICoinSelectResponse {
	fee: number;
	inputs: IUtxo[];
	outputs: IOutput[];
}

/**
 * This method will do its best to select only the necessary inputs that are provided base on the selected sortMethod.
 * // TODO: Migrate to Beignet
 * @param {IUtxo[]} [inputs]
 * @param {IUtxo[]} [outputs]
 * @param {number} [satsPerByte]
 * @param {TCoinSelectPreference} [sortMethod]
 * @param {number} [amountToSend]
 */
export const autoCoinSelect = async ({
	inputs = [],
	outputs = [],
	satsPerByte = 1,
	sortMethod = 'small',
	amountToSend = 0,
}: {
	inputs?: IUtxo[];
	outputs?: IOutput[];
	satsPerByte?: number;
	sortMethod?: TCoinSelectPreference;
	amountToSend?: number;
}): Promise<Result<ICoinSelectResponse>> => {
	try {
		if (!inputs) {
			return err('No inputs provided');
		}
		if (!outputs) {
			return err('No outputs provided');
		}
		if (!amountToSend) {
			//If amountToSend is not specified, attempt to determine how much to send from the output values.
			amountToSend = outputs.reduce((acc, cur) => {
				return acc + Number(cur?.value) || 0;
			}, 0);
		}

		//Sort by the largest UTXO amount (Lowest fee, but reveals your largest UTXO's)
		if (sortMethod === 'large') {
			inputs.sort((a, b) => Number(b.value) - Number(a.value));
		} else {
			//Sort by the smallest UTXO amount (Highest fee, but hides your largest UTXO's)
			inputs.sort((a, b) => Number(a.value) - Number(b.value));
		}

		//Add UTXO's until we have more than the target amount to send.
		let inputAmount = 0;
		let newInputs: IUtxo[] = [];
		let oldInputs: IUtxo[] = [];

		//Consolidate UTXO's if unable to determine the amount to send.
		if (sortMethod === 'consolidate' || !amountToSend) {
			//Add all inputs
			newInputs = [...inputs];
			inputAmount = newInputs.reduce((acc, cur) => {
				return acc + Number(cur.value);
			}, 0);
		} else {
			//Add only the necessary inputs based on the amountToSend.
			await Promise.all(
				inputs.map((input) => {
					if (inputAmount < amountToSend) {
						inputAmount += input.value;
						newInputs.push(input);
					} else {
						oldInputs.push(input);
					}
				}),
			);

			//The provided UTXO's do not have enough to cover the transaction.
			if ((amountToSend && inputAmount < amountToSend) || !newInputs?.length) {
				return err('Not enough funds.');
			}
		}

		// Get all input and output address types for fee calculation.
		const addressIOTypes = {
			inputs: {},
			outputs: {},
		} as IAddressIOTypes;

		await Promise.all([
			newInputs.map(({ address }) => {
				const validateResponse = getAddressInfo(address);
				if (!validateResponse) {
					return;
				}
				const type = validateResponse.type.toUpperCase();
				if (type in addressIOTypes.inputs) {
					addressIOTypes.inputs[type] = addressIOTypes.inputs[type] + 1;
				} else {
					addressIOTypes.inputs[type] = 1;
				}
			}),
			outputs.map(({ address }) => {
				if (!address) {
					return;
				}
				const validateResponse = getAddressInfo(address);
				if (!validateResponse) {
					return;
				}
				const type = validateResponse.type.toUpperCase();
				if (type in addressIOTypes.outputs) {
					addressIOTypes.outputs[type] = addressIOTypes.outputs[type] + 1;
				} else {
					addressIOTypes.outputs[type] = 1;
				}
			}),
		]);

		const baseFee = getByteCount(addressIOTypes.inputs, addressIOTypes.outputs);
		const fee = baseFee * satsPerByte;

		//Ensure we can still cover the transaction with the previously selected UTXO's. Add more UTXO's if not.
		const totalTxCost = amountToSend + fee;
		if (amountToSend && inputAmount < totalTxCost) {
			await Promise.all(
				oldInputs.map((input) => {
					if (inputAmount < totalTxCost) {
						inputAmount += input.value;
						newInputs.push(input);
					}
				}),
			);
		}

		//The provided UTXO's do not have enough to cover the transaction.
		if (inputAmount < totalTxCost || !newInputs?.length) {
			return err('Not enough funds');
		}
		return ok({ inputs: newInputs, outputs, fee });
	} catch (e) {
		return err(e);
	}
};

/**
 * Parses a key derivation path in string format Ex: "m/84'/0'/0'/0/0" and returns IKeyDerivationPath.
 * @param {string} keyDerivationPath
 * @param {TKeyDerivationPurpose | string} [purpose]
 * @param {boolean} [changeAddress]
 * @param {TKeyDerivationAccountType} [accountType]
 * @param {string} [addressIndex]
 * @param {EAvailableNetwork} [selectedNetwork]
 * @return {Result<IKeyDerivationPath>}
 */
export const getKeyDerivationPathObject = ({
	path = '',
	purpose,
	accountType,
	changeAddress,
	addressIndex,
	selectedNetwork,
}: {
	path: string;
	purpose?: TKeyDerivationPurpose;
	accountType?: TKeyDerivationAccountType;
	changeAddress?: boolean;
	addressIndex?: string;
	selectedNetwork?: EAvailableNetwork;
}): Result<IKeyDerivationPath> => {
	try {
		const parsedPath = path.replace(/'/g, '').split('/');

		if (!purpose) {
			purpose = parsedPath[1] as TKeyDerivationPurpose;
		}

		let coinType = parsedPath[2] as TKeyDerivationCoinType;
		if (selectedNetwork) {
			coinType =
				selectedNetwork.toLocaleLowerCase() === EAvailableNetworks.bitcoin
					? '0'
					: '1';
		}

		let account = parsedPath[3] as TKeyDerivationAccount;
		if (accountType) {
			account = getKeyDerivationAccount(accountType);
		}

		let change = parsedPath[4] as TKeyDerivationChange;
		if (changeAddress !== undefined) {
			change = changeAddress ? '1' : '0';
		}

		if (!addressIndex) {
			addressIndex = parsedPath[5];
		}

		return ok({
			purpose,
			coinType,
			account,
			change,
			addressIndex,
		});
	} catch (e) {
		return err(e);
	}
};

/**
 * Returns the next available receive address for the given network and wallet.
 * @param {EAddressType} [addressType]
 * @param {EAvailableNetwork} [selectedNetwork]
 * @return {Result<string>}
 */
export const getReceiveAddress = async ({
	addressType,
	selectedNetwork = getSelectedNetwork(),
}: {
	addressType?: EAddressType;
	selectedNetwork?: EAvailableNetwork;
}): Promise<Result<string>> => {
	try {
		if (!addressType) {
			addressType = getSelectedAddressType({ selectedNetwork });
		}
		const address = await wallet.getAddress({ addressType });
		return address ? ok(address) : err('Unable to get receive address.');
	} catch (e) {
		return err(e);
	}
};
/**
 * Returns the current addressIndex value and will create one if none existed.
 * @param {EAddressType} [addressType]
 * @return {Result<string>}
 */
export const getCurrentAddressIndex = async ({
	addressType,
}: {
	addressType?: EAddressType;
}): Promise<Result<IAddress>> => {
	try {
		addressType = addressType ?? wallet.addressType;
		const currentWallet = wallet.data;
		const addressIndex = currentWallet.addressIndex[addressType];
		const receiveAddress = currentWallet.addressIndex[addressType];
		if (receiveAddress) {
			return ok(receiveAddress);
		}
		const addresses = currentWallet?.addresses[addressType];

		// Check if addresses were generated, but the index has not been set yet.
		if (
			Object.keys(addresses).length > 0 &&
			addressIndex[addressType].index < 0
		) {
			// Grab and return the address at index 0.
			const address = Object.values(addresses).find(({ index }) => index === 0);
			if (address) {
				return ok(address);
			}
		}
		// Fallback to generating a new receive address on the fly.
		const generatedAddress = await generateNewReceiveAddress({
			addressType,
		});
		if (generatedAddress.isOk()) {
			return ok(generatedAddress.value);
		} else {
			console.log(generatedAddress.error.message);
		}
		return err('No address index available.');
	} catch (e) {
		return err(e);
	}
};

/**
 * Retrieves wallet balances for the currently selected wallet and network.
 * @param {TWalletName} [selectedWallet]
 * @param {EAvailableNetwork} [selectedNetwork]
 */
export const getBalance = ({
	selectedWallet = getSelectedWallet(),
	selectedNetwork = getSelectedNetwork(),
}: {
	selectedWallet?: TWalletName;
	selectedNetwork?: EAvailableNetwork;
}): {
	onchainBalance: number; // Total onchain funds
	lightningBalance: number; // Total lightning funds (spendable + reserved + claimable)
	spendingBalance: number; // Share of lightning funds that are spendable
	reserveBalance: number; // Share of lightning funds that are locked up in channels
	claimableBalance: number; // Funds that will be available after a channel opens/closes
	spendableBalance: number; // Total spendable funds (onchain + spendable lightning)
	totalBalance: number; // Total funds (all of the above)
} => {
	const { currentWallet, currentLightningNode: node } = getCurrentWallet({
		selectedWallet,
		selectedNetwork,
	});
	const channels = node?.channels[selectedNetwork];
	const openChannelIds = node?.openChannelIds[selectedNetwork];
	const claimableBalances = node?.claimableBalances[selectedNetwork];
	const openChannels = Object.values(channels).filter((channel) => {
		return openChannelIds.includes(channel.channel_id);
	});

	// Get the total spending & reserved balance of all open channels
	let spendingBalance = 0;
	let reserveBalance = 0;
	openChannels.forEach((channel) => {
		if (channel.is_channel_ready) {
			const spendable = channel.outbound_capacity_sat;
			const unspendable = channel.balance_sat - spendable;
			reserveBalance += unspendable;
			spendingBalance += spendable;
		}
	});

	// TODO: filter out some types of claimable balances
	const result = reduceValue(claimableBalances, 'amount_satoshis');
	const claimableBalance = result.isOk() ? result.value : 0;

	const onchainBalance =
		wallet.getBalance() ?? currentWallet.balance[selectedNetwork];
	const lightningBalance = spendingBalance + reserveBalance + claimableBalance;
	const spendableBalance = onchainBalance + spendingBalance;
	const totalBalance =
		onchainBalance + spendingBalance + reserveBalance + claimableBalance;

	return {
		onchainBalance,
		lightningBalance,
		spendingBalance,
		reserveBalance,
		claimableBalance,
		spendableBalance,
		totalBalance,
	};
};

/**
 * This method will clear the utxo array for each address type and reset the
 * address indexes back to the original/default app values. Once cleared & reset
 * the app will rescan the wallet's addresses from index zero.
 * @param {boolean} [shouldClearAddresses] - Clears and re-generates all addresses when true.
 * @param {boolean} [shouldClearTransactions]
 * @returns {Promise<Result<string>>}
 */
export const rescanAddresses = async ({
	shouldClearAddresses = true,
	shouldClearTransactions = false,
}: {
	shouldClearAddresses?: boolean;
	shouldClearTransactions?: boolean;
}): Promise<Result<IWalletData>> => {
	const res = await wallet.rescanAddresses({
		shouldClearAddresses,
		shouldClearTransactions,
	});
	if (res.isErr()) {
		handleRefreshError(res.error.message);
		return err(res.error.message);
	}
	return res;
};

/**
 * Returns the number of confirmations for a given block height.
 * @param {number} height
 * @param {number} [currentHeight]
 * @returns {number}
 */
export const blockHeightToConfirmations = ({
	blockHeight,
	currentHeight,
}: {
	blockHeight?: number;
	currentHeight?: number;
}): number => {
	if (!blockHeight) {
		return 0;
	}
	if (!currentHeight) {
		const header = getBlockHeader();
		currentHeight = header.height;
	}
	if (currentHeight < blockHeight) {
		return 0;
	}
	return currentHeight - blockHeight + 1;
};

export const getOnChainWallet = (): Wallet => {
	return wallet;
};

export const getOnChainWalletTransaction = (): Transaction => {
	return wallet.transaction;
};

export const getOnChainWalletElectrum = (): Electrum => {
	return wallet?.electrum;
};

export const getOnChainWalletTransactionData = (): ISendTransaction => {
	return wallet.transaction.data;
};

export const getOnChainWalletData = (): IWalletData => {
	return wallet?.data;
};

export const switchNetwork = async (
	selectedNetwork: EAvailableNetwork,
	servers?: TServer | TServer[],
): Promise<Result<boolean>> => {
	const originalNetwork = getSelectedNetwork();
	if (!servers) {
		servers = getCustomElectrumPeers({ selectedNetwork });
	}
	await promiseTimeout(2000, ldk.stop());
	// Wipe existing activity
	dispatch(resetActivityState());
	// Switch to new network.
	updateWallet({ selectedNetwork });
	const response = await wallet.switchNetwork(
		EAvailableNetworks[selectedNetwork],
		servers,
	);
	if (response.isErr()) {
		updateWallet({ selectedNetwork: originalNetwork });
		return err(response.error.message);
	}
	setTimeout(updateActivityList, 500);
	return ok(true);
};
