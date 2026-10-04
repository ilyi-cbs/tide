sap.ui.define(["sap/ui/util/Storage", "sap/base/util/uid"], function (Storage, uid) {
  "use strict";

  const storage = new Storage(Storage.Type.session, "tide.workflow.pending");
  const attempts = new Map();
  let scope = "";
  let initialized = false;
  let identityReady = Promise.resolve();
  let identityError;

  function storageKey(key) {
    if (initialized && !scope)
      throw identityError || new Error("The signed-in user is not yet available. No write was sent.");
    return scope ? scope + ":" + key : key;
  }

  return {
    initialize: function (identity) {
      initialized = true;
      scope = "";
      identityError = undefined;
      attempts.clear();
      const readiness = Promise.resolve(identity).then(function (value) {
        if (!value?.userId || !value.origin)
          throw new Error("The signed-in user could not be verified. No write was sent.");
        if (identityReady === readiness)
          scope = encodeURIComponent(JSON.stringify(["tide.cockpit", value.origin, value.userId]));
      }).catch(function (error) {
        if (identityReady === readiness) identityError = error;
      });
      identityReady = readiness;
    },
    remember: function (key, commandID, target, commandType, parameters) {
      if (!storage.put(storageKey(key), { commandID: commandID, target: target, commandType: commandType,
        parameters: parameters ? JSON.parse(JSON.stringify(parameters)) : undefined }))
        throw new Error(
          "Pending command recovery storage is unavailable. No write was sent.",
        );
    },
    forget: function (key) {
      storage.remove(storageKey(key));
    },
    reconcile: async function (model, key, target) {
      await identityReady;
      const recoveryKey = storageKey(key);
      const legacy = initialized && !storage.get(recoveryKey) ? storage.get(key) : null;
      const pending = storage.get(recoveryKey) || legacy;
      if (!pending) return Promise.resolve();
      if (!pending.commandID || pending.target !== target)
        return Promise.reject(
          new Error("Pending command recovery identity is invalid."),
        );
      const receipt = model.bindContext("/commandResult(...)");
      receipt.setParameter("commandID", pending.commandID);
      if (pending.commandType && pending.parameters) {
        const argumentsObject = { ...pending.parameters };
        delete argumentsObject.commandID;
        receipt.setParameter("commandType", pending.commandType);
        receipt.setParameter("arguments", JSON.stringify(argumentsObject));
      }
      return receipt
        .invoke("$direct")
        .then(function () {
          const result = receipt.getBoundContext().getObject();
          if (
            !result || result.payloadMatched === false ||
            (result.caseID !== target && result.actionID !== target)
          )
            throw new Error("The previous command outcome is still unknown.");
          storage.remove(recoveryKey);
          if (legacy) storage.remove(key);
          return result;
        })
        .finally(function () {
          receipt.destroy();
        });
    },
    execute: async function (model, key, target, commandType, parameters) {
      await identityReady;
      const recoveryKey = storageKey(key);
      let attempt = attempts.get(recoveryKey);
      if (attempt?.busy) throw new Error("The previous command is still in flight.");
      if (attempt && (attempt.target !== target || attempt.commandType !== commandType ||
        Object.entries(parameters).some(function (entry) {
          return !["expectedModifiedAt", "expectedFingerprint", "expectedEvidence", "expectedReviewToken"].includes(entry[0]) &&
            JSON.stringify(entry[1]) !== JSON.stringify(attempt.parameters[entry[0]]);
        }))) throw new Error("Reconcile the previous command before changing the decision.");
      if (!attempt) {
        const pending = storage.get(recoveryKey) || (initialized ? storage.get(key) : null);
        if (pending) {
          attempts.set(recoveryKey, { busy: true });
          try {
            const result = await this.reconcile(model, key, target);
            if (!pending.commandType || pending.commandType !== commandType)
              throw new Error("The previous command was recovered. Review its outcome before sending a different decision.");
            const changed = Object.entries(parameters).some(function (entry) {
              return !["commandID", "expectedModifiedAt", "expectedFingerprint", "expectedEvidence", "expectedReviewToken"].includes(entry[0]) &&
                JSON.stringify(entry[1]) !== JSON.stringify(pending.parameters?.[entry[0]]);
            });
            if (changed) throw new Error("The previous command was recovered. Review its outcome before changing the decision.");
            return result;
          }
          finally { attempts.delete(recoveryKey); }
        }
        attempt = { target: target, commandType: commandType, parameters: { ...JSON.parse(JSON.stringify(parameters)), commandID: uid() }, busy: false };
        attempts.set(recoveryKey, attempt);
      }
      attempt.busy = true;
      let operation;
      let sent = false;
      try {
        this.remember(key, attempt.parameters.commandID, target, attempt.commandType, attempt.parameters);
        operation = model.bindContext("/" + attempt.commandType + "(...)");
        Object.entries(attempt.parameters).forEach(function (entry) {
          operation.setParameter(entry[0], entry[1]);
        });
        sent = true;
        await operation.invoke("$direct");
        const result = operation.getBoundContext().getObject();
        if (!result || (result.caseID !== target && result.actionID !== target))
          throw new Error("The command outcome is still unknown.");
        attempts.delete(recoveryKey);
        storage.remove(recoveryKey);
        return result;
      } catch (error) {
        if (sent) {
          try {
            const result = await this.reconcile(model, key, target);
            if (result) {
              attempts.delete(recoveryKey);
              return result;
            }
          } catch (lookupError) {
            const status = Number(error.status ?? error.statusCode);
            if (status >= 400 && status < 500 && ![408, 429].includes(status)) {
              attempts.delete(recoveryKey);
              storage.remove(recoveryKey);
            }
          }
        } else attempts.delete(recoveryKey);
        throw error;
      } finally {
        attempt.busy = false;
        operation?.destroy();
      }
    },
  };
});
