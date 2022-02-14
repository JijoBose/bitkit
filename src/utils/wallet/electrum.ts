import * as electrum from 'rn-electrum-client/helpers';
import * as peers from 'rn-electrum-client/helpers/peers.json';
import * as tls from '../electrum/tls';

import { TAvailableNetworks } from '../networks';
import { err, ok, Result } from '../result';
import { IAddressContent, IUtxo, IWalletItem } from '../../store/types/wallet';
import {
	getAddressTypes,
	getCurrentWallet,
	getCustomElectrumPeers,
	getScriptHash,
	getSelectedNetwork,
	getSelectedWallet,
	ITransaction,
	ITxHash,
	refreshWallet,
} from './index';
import { showSuccessNotification } from '../notifications';
import { ICustomElectrumPeer } from '../../store/types/settings';

export interface IGetUtxosResponse {
	utxos: IUtxo[];
	balance: number;
}

/**
 * Returns utxos for a given wallet and network along with the available balance.
 * @param selectedWallet
 * @param selectedNetwork
 */
export const getUtxos = async ({
	selectedWallet,
	selectedNetwork,
}: {
	selectedWallet?: string;
	selectedNetwork?: TAvailableNetworks;
}): Promise<Result<IGetUtxosResponse>> => {
	try {
		if (!selectedNetwork) {
			selectedNetwork = getSelectedNetwork();
		}
		if (!selectedWallet) {
			selectedWallet = getSelectedWallet();
		}
		const { currentWallet } = getCurrentWallet({
			selectedNetwork,
			selectedWallet,
		});

		const addressTypes = getAddressTypes();
		let utxos: IUtxo[] = [];
		let balance = 0;
		await Promise.all(
			Object.keys(addressTypes).map(async (addressTypeKey) => {
				if (!selectedNetwork) {
					selectedNetwork = getSelectedNetwork();
				}
				if (!selectedWallet) {
					selectedWallet = getSelectedWallet();
				}
				const unspentAddressResult =
					await electrum.listUnspentAddressScriptHashes({
						scriptHashes: {
							key: 'scriptHash',
							data: {
								...currentWallet.addresses[selectedNetwork][addressTypeKey],
								...currentWallet.changeAddresses[selectedNetwork][
									addressTypeKey
								],
							},
						},
						network: selectedNetwork,
					});
				if (unspentAddressResult.error) {
					return err(unspentAddressResult.data);
				}
				await Promise.all(
					unspentAddressResult.data.map(({ data, result }) => {
						if (result && result?.length > 0) {
							return result.map((unspentAddress: IUtxo) => {
								balance = balance + unspentAddress.value;
								utxos.push({
									...data,
									...unspentAddress,
								});
							});
						}
					}),
				);
			}),
		);
		return ok({ utxos, balance });
	} catch (e) {
		return err(e);
	}
};

export interface ISubscribeToAddress {
	data: {
		id: number;
		jsonrpc: string;
		result: null;
	};
	error: boolean;
	id: number;
	method: string;
}

/**
 * Subscribes to the next available addressScriptHash.
 * @param {TAvailableNetworks} [selectedNetwork]
 * @param {string} [selectedWallet]
 * @param scriptHashes
 * @param showNotification
 * @param onReceive
 * @return {Promise<Result<string>>}
 */
export const subscribeToAddresses = async ({
	selectedNetwork,
	selectedWallet,
	scriptHashes = [],
	showNotification = true,
	onReceive = (): null => null,
}: {
	selectedNetwork?: TAvailableNetworks;
	selectedWallet?: string;
	scriptHashes?: string[];
	showNotification?: boolean;
	onReceive?: Function;
}): Promise<Result<string>> => {
	const addressTypes = getAddressTypes();
	const { currentWallet } = getCurrentWallet({
		selectedNetwork,
		selectedWallet,
	});
	// Gather the receiving address scripthash for each address type if no scripthashes were provided.
	if (!scriptHashes?.length) {
		await Promise.all(
			Object.keys(addressTypes).map(async (addressType) => {
				if (!selectedNetwork) {
					selectedNetwork = getSelectedNetwork();
				}
				if (!selectedWallet) {
					selectedWallet = getSelectedWallet();
				}
				scriptHashes.push(
					currentWallet.addressIndex[selectedNetwork][addressType].scriptHash,
				);
			}),
		);
	}
	// Subscribe to all provided scriphashes.
	await Promise.all(
		scriptHashes?.map(async (addressScriptHash) => {
			const subscribeAddressResponse: ISubscribeToAddress =
				await electrum.subscribeAddress({
					scriptHash: addressScriptHash,
					network: selectedNetwork,
					onReceive: (data): void => {
						if (showNotification) {
							showSuccessNotification({
								title: 'Received BTC',
								message: data[1], //TODO: Include amount received as the message.
							});
						}
						refreshWallet();
						onReceive();
					},
				});
			if (subscribeAddressResponse.error) {
				return err('Unable to subscribe to receiving addresses.');
			}
		}),
	);
	return ok('Successfully subscribed to addresses.');
};

interface ISubscribeToHeader {
	data: {
		height: number;
		hex: string;
	};
	error: boolean;
	id: string;
	method: string;
}

/**
 * Subscribes to the current networks headers.
 * @param {string} [selectedNetwork]
 * @return {Promise<Result<string>>}
 */
export const subscribeToHeader = async ({
	selectedNetwork,
}: {
	selectedNetwork?: undefined | TAvailableNetworks;
}): Promise<Result<string>> => {
	if (!selectedNetwork) {
		selectedNetwork = getSelectedNetwork();
	}
	const subscribeResponse: ISubscribeToHeader = await electrum.subscribeHeader({
		network: selectedNetwork,
		onReceive: refreshWallet,
	});
	if (subscribeResponse.error) {
		return err('Unable to subscribe to headers.');
	}
	return ok('Successfully subscribed to headers.');
};

interface IGetTransactions {
	error: boolean;
	id: number;
	method: string;
	network: string;
	data: ITransaction<IUtxo>[];
}
/**
 * Returns available transaction from electrum based on the provided txHashes.
 * @param {ITxHash[]} txHashes
 * @param {TAvailableNetworks} [selectedNetwork]
 * @return {Promise<Result<IGetTransactions>>}
 */
export const getTransactions = async ({
	txHashes = [],
	selectedNetwork,
}: {
	txHashes: ITxHash[];
	selectedNetwork?: TAvailableNetworks;
}): Promise<Result<IGetTransactions>> => {
	try {
		if (!selectedNetwork) {
			selectedNetwork = getSelectedNetwork();
		}
		if (txHashes.length < 1) {
			return ok({
				error: false,
				id: 0,
				method: 'getTransactions',
				network: selectedNetwork,
				data: [],
			});
		}
		let paths: string[] = [];
		txHashes = txHashes.filter((txHash) => {
			// @ts-ignore
			if (!paths.includes(txHash?.path)) {
				// @ts-ignore
				paths.push(txHash.path);
				return txHash;
			}
		});
		const data = {
			key: 'tx_hash',
			data: txHashes,
		};
		const response = await electrum.getTransactions({
			txHashes: data,
			network: selectedNetwork,
		});
		if (response.error) {
			return err(response);
		}
		return ok(response);
	} catch (e) {
		return err(e);
	}
};

export interface IPeerData {
	host: string;
	port: string | number;
	protocol: 'tcp' | 'ssl' | string;
}

/**
 * Returns the currently connected Electrum peer.
 * @param {TAvailableNetworks} [selectedNetwork]
 * @return {Promise<Result<IPeerData>>}
 */
export const getConnectedPeer = async (
	selectedNetwork,
): Promise<Result<IPeerData>> => {
	try {
		if (!selectedNetwork) {
			selectedNetwork = getSelectedNetwork();
		}
		const response = await electrum.getConnectedPeer(selectedNetwork);
		if (response && response?.host && response?.port && response?.protocol) {
			return ok(response);
		}
		return err('No peer available.');
	} catch (e) {
		return err(e);
	}
};

interface IGetTransactionsFromInputs {
	error: boolean;
	id: number;
	method: string;
	network: string;
	data: ITransaction<{
		tx_hash: string;
		vout: number;
	}>[];
}

/**
 * Returns transactions associated with the provided transaction hashes.
 * @param {ITxHash[]} txHashes
 * @param {TAvailableNetworks} [selectedNetwork]
 * @return {Promise<Result<IGetTransactionsFromInputs>>}
 */
export const getTransactionsFromInputs = async ({
	txHashes = [],
	selectedNetwork,
}: {
	txHashes: ITxHash[];
	selectedNetwork?: TAvailableNetworks;
}): Promise<Result<IGetTransactionsFromInputs>> => {
	try {
		const data = {
			key: 'tx_hash',
			data: txHashes,
		};
		const response = await electrum.getTransactions({
			txHashes: data,
			network: selectedNetwork,
		});
		if (!response.error) {
			return ok(response);
		} else {
			return err(response);
		}
	} catch (e) {
		return err(e);
	}
};

export interface TTxResult {
	tx_hash: string;
	height: number;
}

interface TTxResponse {
	data: IAddressContent;
	id: number;
	jsonrpc: string;
	param: string;
	result: TTxResult[];
}

interface IGetAddressScriptHashesHistoryResponse {
	data: TTxResponse[];
	error: boolean;
	id: number;
	method: string;
	network: string;
}

export interface IGetAddressHistoryResponse
	extends TTxResult,
		IAddressContent {}

/**
 * Returns the available history for the provided address script hashes.
 * @param {IAddressContent[]} [scriptHashes]
 * @param {TAvailableNetworks} [selectedNetwork]
 * @param {string} [selectedWallet]
 */
export const getAddressHistory = async ({
	scriptHashes,
	selectedNetwork,
	selectedWallet,
}: {
	scriptHashes?: IAddressContent[];
	selectedNetwork?: TAvailableNetworks;
	selectedWallet?: string;
}): Promise<Result<IGetAddressHistoryResponse[]>> => {
	try {
		if (!selectedNetwork) {
			selectedNetwork = getSelectedNetwork();
		}
		if (!selectedWallet) {
			selectedWallet = getSelectedWallet();
		}
		const { currentWallet } = getCurrentWallet({
			selectedNetwork,
			selectedWallet,
		});
		const currentAddresses = currentWallet.addresses[selectedNetwork];
		const currentChangeAddresses =
			currentWallet.changeAddresses[selectedNetwork];
		if (!scriptHashes || scriptHashes?.length < 1) {
			let paths: string[] = [];
			const addressTypes = getAddressTypes();
			await Promise.all(
				Object.keys(addressTypes).map((addressType) => {
					const addresses = currentAddresses[addressType];
					const changeAddresses = currentChangeAddresses[addressType];
					const addressValues: IAddressContent[] = Object.values(addresses);
					const changeAddressValues: IAddressContent[] =
						Object.values(changeAddresses);
					scriptHashes = [...addressValues, ...changeAddressValues].filter(
						(scriptHash) => {
							if (!paths.includes(scriptHash?.path)) {
								paths.push(scriptHash.path);
								return scriptHash;
							}
						},
					);
				}),
			);
		}
		if (!scriptHashes || scriptHashes?.length < 1) {
			return err('No scriptHashes available to check.');
		}
		const payload = {
			key: 'scriptHash',
			data: scriptHashes,
		};
		const response: IGetAddressScriptHashesHistoryResponse =
			await electrum.getAddressScriptHashesHistory({
				scriptHashes: payload,
				network: selectedNetwork,
			});

		const mempoolResponse: IGetAddressScriptHashesHistoryResponse =
			await electrum.getAddressScriptHashesMempool({
				scriptHashes: payload,
				network: selectedNetwork,
			});

		if (response.error || mempoolResponse.error) {
			return err('Unable to get address history.');
		}

		const combinedResponse = [...response.data, ...mempoolResponse.data];

		let history: IGetAddressHistoryResponse[] = [];
		combinedResponse.map(
			({
				data,
				result,
			}: {
				data: IAddressContent;
				result: TTxResult[];
			}): void => {
				if (result && result?.length > 0) {
					result.map((item) => {
						history.push({ ...data, ...item });
					});
				}
			},
		);

		return ok(history);
	} catch (e) {
		return err(e);
	}
};

const tempElectrumServers: IWalletItem<ICustomElectrumPeer[]> = {
	bitcoin: peers.bitcoin,
	bitcoinTestnet: peers.bitcoinTestnet,
};

/**
 * Connects to the provided electrum peer. Otherwise, it will attempt to connect to a set of default peers.
 * @param {TAvailableNetworks} [selectedNetwork]
 * @param {number} [retryAttempts]
 * @param {ICustomElectrumPeer[]} [customPeers]
 * @param {{ net: undefined, tls: undefined }} [options]
 * @return {Promise<Result<string>>}
 */
export const connectToElectrum = async ({
	selectedNetwork,
	retryAttempts = 2,
	customPeers,
	options = { net: undefined, tls: undefined },
}: {
	selectedNetwork?: TAvailableNetworks;
	retryAttempts?: number;
	customPeers?: ICustomElectrumPeer[];
	options?: { net?: any; tls?: any };
}): Promise<Result<string>> => {
	if (!selectedNetwork) {
		selectedNetwork = getSelectedNetwork();
	}
	// @ts-ignore
	const net = options.net ?? global?.net;
	const _tls = options.tls ?? tls;

	//Attempt to disconnect from any old/lingering connections
	await electrum.stop({ network: selectedNetwork });

	// Fetch any stored custom peers.
	if (!customPeers) {
		customPeers = getCustomElectrumPeers({ selectedNetwork });
	}
	if (customPeers.length < 1) {
		customPeers = tempElectrumServers[selectedNetwork];
	}
	let startResponse = { error: true, data: '' };
	for (let i = 0; i < retryAttempts; i++) {
		startResponse = await electrum.start({
			network: selectedNetwork,
			customPeers,
			net,
			tls: _tls,
		});
		if (!startResponse.error) {
			break;
		}
	}

	if (startResponse.error) {
		//Attempt one more time
		const { error, data } = await electrum.start({
			network: selectedNetwork,
			customPeers,
			net,
			tls: _tls,
		});
		if (error) {
			return err(data);
		}
	}
	return ok('Successfully connected.');
};

/**
 * Returns combined balance of provided addresses.
 * @param {string[]} addresses
 * @param {TAvailableNetworks} [selectedNetwork]
 */
export const getAddressBalance = async ({
	addresses = [],
	selectedNetwork,
}: {
	addresses: string[];
	selectedNetwork?: TAvailableNetworks;
}): Promise<Result<number>> => {
	try {
		if (!selectedNetwork) {
			selectedNetwork = getSelectedNetwork();
		}
		const scriptHashes = await Promise.all(
			addresses.map((address) => {
				if (!selectedNetwork) {
					selectedNetwork = getSelectedNetwork();
				}
				return getScriptHash(address, selectedNetwork);
			}),
		);
		const res = await electrum.getAddressScriptHashBalances({
			scriptHashes,
			network: selectedNetwork,
		});
		if (res.error) {
			return err(res.data);
		}
		return ok(
			res.data.reduce((acc, cur) => {
				return (
					acc +
					Number(cur.result?.confirmed ?? 0) +
					Number(cur.result?.unconfirmed ?? 0)
				);
			}, 0) || 0,
		);
	} catch (e) {
		return err(e);
	}
};
