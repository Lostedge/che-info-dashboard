"""
SQL 查询
"""

# 堆场设备作业统计（RTG、FL、RS）
YM_STATS = """
    SELECT
        SUBSTR(CY_MACH_NO, -3)                                         AS id,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20' THEN 1 END)                AS day_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40' THEN 1 END)                AS day_40,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_40
    FROM JZCT_TOS_HIS.CY_COMMAND
    WHERE WORK_TIM IS NOT NULL
      AND WORK_TIM >= TRUNC(SYSDATE)
      AND WORK_TIM <  :period_end
      AND CY_MACH_NO IS NOT NULL
      AND QUEUE_TYP IN ('SI','SO','TI','TO')
    GROUP BY CY_MACH_NO
    ORDER BY CY_MACH_NO
"""

# 岸桥作业统计
QC_STATS = """
    SELECT
        SUBSTR(SHIP_MACH_NO, -3)                                       AS id,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20' THEN 1 END)                AS day_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40' THEN 1 END)                AS day_40,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_40
    FROM JZCT_TOS_HIS.SHIP_COMMAND
    WHERE WORK_TIM IS NOT NULL
      AND WORK_TIM >= TRUNC(SYSDATE)
      AND WORK_TIM <  :period_end
      AND SHIP_MACH_NO IS NOT NULL
    GROUP BY SHIP_MACH_NO
    ORDER BY SHIP_MACH_NO
"""

# 堆场设备信息（RTG、FL）
YM_INFO = """
    SELECT
        SUBSTR(p.MACH_NO, -3)                       AS id,
        p.CURRENT_ID                                AS status,
        COALESCE(o.OPER_NAM, p.MACH_OPER_COD)       AS driver
    FROM JZCT_TOS.CY_MACH_PLAC p
    LEFT JOIN JZCT_CODE.C_OPERATOR o ON p.MACH_OPER_COD = o.OPER_COD
    WHERE p.MACH_NO LIKE 'CQ%'
       OR p.MACH_NO LIKE 'DGJ%'
"""

# 岸桥设备信息
QC_INFO = """
    SELECT
        SUBSTR(p.MACH_NO, -3)                       AS id,
        p.CURRENT_ID                                AS status,
        p.CUR_BAY_NO                                AS bay,
        COALESCE(o.OPER_NAM, p.MACH_OPER_COD)       AS driver,
        COALESCE(v.SHIP_NAM, p.VOYAGE_NO)           AS ship_name
    FROM JZCT_TOS.SHIP_MACH_PLAC p
    LEFT JOIN JZCT_CODE.C_OPERATOR o ON p.MACH_OPER_COD = o.OPER_COD
    LEFT JOIN JZCT_TOS_HIS.SHIP_VOYAGE v ON p.VOYAGE_NO = v.VOYAGE_NO
    WHERE p.MACH_NO LIKE 'AQ%'
"""

# 船舶信息
SHIP_INFO = """
    SELECT
        p.VOYAGE_NO                                             AS id,
        p.SHIP_STAT_ID                                          AS status,
        p.SHIP_NAM 
            || ' ' || COALESCE(p.I_VOYAGE, '-')
            || '/' || COALESCE(p.E_VOYAGE, '-')                 AS ship_label,
        p.ETA                                                   AS eta,
        p.RTB                                                   AS rtb,
        p.BEG_WORK_TIM                                          AS beg_work_tim
    FROM JZCT_TOS_HIS.SHIP_VOYAGE p
    WHERE p.SHIP_STAT_ID IN ('Y', 'C', 'D', 'E')
"""
