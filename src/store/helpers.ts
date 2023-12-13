import cloneDeep from 'lodash/cloneDeep';

import store, { RootState } from '../store';
import { IWalletStore } from './types/wallet';
import { ISettings } from './types/settings';
import { IMetadata } from './types/metadata';
import { TActivity } from './slices/activity';
import { ILightning } from './types/lightning';
import { IBlocktank } from './types/blocktank';
import { TFeesState } from './slices/fees';
import { ISlashtags } from './types/slashtags';
import { ITodos } from './types/todos';
import { TUiState } from './types/ui';
import { IUser } from './types/user';
import { IWidgetsStore } from './types/widgets';
import { IChecksShape } from './types/checks';
import { IBackup } from './types/backup';

/*
Used to retrieve the store outside of a component.
 */
export const getStore = (): RootState => {
	return cloneDeep(store.getState());
};
export const getWalletStore = (): IWalletStore => {
	return cloneDeep(store.getState().wallet);
};

export const getSettingsStore = (): ISettings => {
	return cloneDeep(store.getState().settings);
};

export const getMetaDataStore = (): IMetadata => {
	return cloneDeep(store.getState().metadata);
};

export const getActivityStore = (): TActivity => {
	return cloneDeep(store.getState().activity);
};

export const getLightningStore = (): ILightning => {
	return cloneDeep(store.getState().lightning);
};

export const getBlocktankStore = (): IBlocktank => {
	return cloneDeep(store.getState().blocktank);
};

export const getFeesStore = (): TFeesState => {
	return cloneDeep(store.getState().fees);
};

export const getSlashtagsStore = (): ISlashtags => {
	return cloneDeep(store.getState().slashtags);
};

export const getTodosStore = (): ITodos => {
	return cloneDeep(store.getState().todos);
};

export const getUiStore = (): TUiState => {
	return cloneDeep(store.getState().ui);
};

export const getUserStore = (): IUser => {
	return cloneDeep(store.getState().user);
};

export const getWidgetsStore = (): IWidgetsStore => {
	return cloneDeep(store.getState().widgets);
};

export const getChecksStore = (): IChecksShape => {
	return cloneDeep(store.getState().checks);
};

export const getBackupStore = (): IBackup => {
	return cloneDeep(store.getState().backup);
};

/*
Used to dispatch outside of a component.
 */
export const { dispatch } = store;
