// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { injectable } from 'inversify';
import * as uuid from 'uuid/v4';
import { Event, EventEmitter, NotebookDocument } from 'vscode';
import { CancellationToken } from 'vscode-jsonrpc';
import '../../common/extensions';
import { traceInfo } from '../../common/logger';
import { IAsyncDisposableRegistry, IDisposableRegistry, Resource } from '../../common/types';
import * as localize from '../../common/utils/localize';
import { noop } from '../../common/utils/misc';
import { captureTelemetry } from '../../telemetry';
import { Telemetry } from '../constants';
import { KernelConnectionMetadata } from '../jupyter/kernels/types';
import {
    ConnectNotebookProviderOptions,
    INotebook,
    IRawConnection,
    IRawNotebookProvider,
    IRawNotebookSupportedService
} from '../types';

export class RawConnection implements IRawConnection {
    public readonly type = 'raw';
    public readonly localLaunch = true;
    public readonly valid = true;
    public readonly displayName = '';
    private eventEmitter: EventEmitter<number> = new EventEmitter<number>();

    public dispose() {
        noop();
    }
    public get disconnected(): Event<number> {
        return this.eventEmitter.event;
    }
}

@injectable()
export class RawNotebookProviderBase implements IRawNotebookProvider {
    public get id(): string {
        return this._id;
    }
    // Keep track of the notebooks that we have provided
    private notebooks = new Map<string, Promise<INotebook>>();
    private rawConnection: IRawConnection | undefined;
    private _id = uuid();

    constructor(
        private asyncRegistry: IAsyncDisposableRegistry,
        private rawNotebookSupportedService: IRawNotebookSupportedService,
        private readonly disposables: IDisposableRegistry
    ) {
        this.asyncRegistry.push(this);
    }

    public connect(options: ConnectNotebookProviderOptions): Promise<IRawConnection | undefined> {
        // For getOnly, we don't want to create a connection, even though we don't have a server
        // here we only want to be "connected" when requested to mimic jupyter server function
        if (options.getOnly) {
            return Promise.resolve(this.rawConnection);
        }

        // If not get only, create if needed and return
        if (!this.rawConnection) {
            this.rawConnection = new RawConnection();
        }
        return Promise.resolve(this.rawConnection);
    }

    // Check to see if we have all that we need for supporting raw kernel launch
    public get isSupported(): boolean {
        return this.rawNotebookSupportedService.isSupported;
    }

    @captureTelemetry(Telemetry.RawKernelCreatingNotebook, undefined, true)
    public async createNotebook(
        document: NotebookDocument,
        resource: Resource,
        kernelConnection: KernelConnectionMetadata,
        disableUI: boolean,
        cancelToken?: CancellationToken
    ): Promise<INotebook> {
        return this.createNotebookInstance(
            resource,
            document,
            kernelConnection,
            disableUI,
            cancelToken
        );
    }

    public async getNotebook(document: NotebookDocument): Promise<INotebook | undefined> {
        return this.notebooks.get(document.uri.toString());
    }

    public async dispose(): Promise<void> {
        traceInfo(`Shutting down notebooks for ${this.id}`);
        const notebooks = await Promise.all([...this.notebooks.values()]);
        await Promise.all(notebooks.map((n) => n?.session.dispose()));
    }

    // This may be a bit of a noop in the raw case
    public getDisposedError(): Error {
        return new Error(localize.DataScience.rawConnectionBrokenError());
    }

    protected getNotebooks(): Promise<INotebook>[] {
        return [...this.notebooks.values()];
    }

    protected getConnection(): IRawConnection {
        // At the time of getConnection force a connection if not created already
        // should always have happened already, but the check here lets us avoid returning undefined option
        if (!this.rawConnection) {
            this.rawConnection = new RawConnection();
        }
        return this.rawConnection;
    }

    protected setNotebook(document: NotebookDocument, notebook: Promise<INotebook>) {
        const removeNotebook = () => {
            if (this.notebooks.get(document.uri.toString()) === notebook) {
                this.notebooks.delete(document.uri.toString());
            }
        };

        notebook
            .then((nb) => {
                nb.session.onDidDispose(
                    () => {
                        if (this.notebooks.get(document.uri.toString()) === notebook) {
                            this.notebooks.delete(document.uri.toString());
                        }
                    },
                    this,
                    this.disposables
                );
            })
            .catch(removeNotebook);

        // Save the notebook
        this.notebooks.set(document.uri.toString(), notebook);
    }

    protected createNotebookInstance(
        _resource: Resource,
        _document: NotebookDocument,
        _kernelConnection?: KernelConnectionMetadata,
        _disableUI?: boolean,
        _cancelToken?: CancellationToken
    ): Promise<INotebook> {
        throw new Error('You forgot to override createNotebookInstance');
    }
}
