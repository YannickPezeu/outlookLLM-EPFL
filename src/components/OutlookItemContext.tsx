import React, { createContext, useContext, useState, useCallback } from "react";
import type { OutlookItemData } from "../types/dialogMessages";

interface OutlookItemContextValue {
  item: OutlookItemData | null;
  setItem: (item: OutlookItemData | null) => void;
}

const OutlookItemContext = createContext<OutlookItemContextValue>({
  item: null,
  setItem: () => {},
});

export const useOutlookItem = () => useContext(OutlookItemContext);

export const OutlookItemProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [item, setItemState] = useState<OutlookItemData | null>(null);

  const setItem = useCallback((newItem: OutlookItemData | null) => {
    setItemState(newItem);
  }, []);

  return (
    <OutlookItemContext.Provider value={{ item, setItem }}>
      {children}
    </OutlookItemContext.Provider>
  );
};
